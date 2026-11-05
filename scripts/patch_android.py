from pathlib import Path
import shutil
import os
import re
import json
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
APPLICATION_ID = os.environ.get("ANDROID_APPLICATION_ID", "app.primeops.mobile")
APP_NAME = os.environ.get("ANDROID_APP_NAME", "PrimeOps")
if not re.fullmatch(r"[A-Za-z0-9 ._-]{1,60}", APP_NAME):
    raise ValueError("Invalid Android app name")
LEGACY_APPLICATION_ID = json.loads((ROOT / "www/legacy-identifiers.json").read_text())["androidApplicationId"]
if not re.fullmatch(r"[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+", APPLICATION_ID):
    raise ValueError("Invalid Android application identity")
ANDROID_NS = "http://schemas.android.com/apk/res/android"
TOOLS_NS = "http://schemas.android.com/tools"
ET.register_namespace("android", ANDROID_NS)
ET.register_namespace("tools", TOOLS_NS)


def android_attribute(name):
    return f"{{{ANDROID_NS}}}{name}"


def patch_manifest(manifest_path):
    tree = ET.parse(manifest_path)
    manifest = tree.getroot()

    camera_permission = next(
        (
            element
            for element in manifest.findall("uses-permission")
            if element.get(android_attribute("name")) == "android.permission.CAMERA"
        ),
        None,
    )
    if camera_permission is None:
        camera_permission = ET.Element(
            "uses-permission",
            {android_attribute("name"): "android.permission.CAMERA"},
        )
        manifest.insert(0, camera_permission)

    for permission in ("ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "REQUEST_INSTALL_PACKAGES"):
        name = f"android.permission.{permission}"
        if not any(element.get(android_attribute("name")) == name for element in manifest.findall("uses-permission")):
            ET.SubElement(manifest, "uses-permission", {android_attribute("name"): name})

    camera_feature = next(
        (
            element
            for element in manifest.findall("uses-feature")
            if element.get(android_attribute("name")) == "android.hardware.camera.any"
        ),
        None,
    )
    if camera_feature is None:
        camera_feature = ET.SubElement(manifest, "uses-feature")
    camera_feature.set(android_attribute("name"), "android.hardware.camera.any")
    camera_feature.set(android_attribute("required"), "false")

    app = manifest.find("application")
    if app is None:
        raise RuntimeError(f"No <application> element found in {manifest_path}")

    app.set(android_attribute("usesCleartextTraffic"), "true")

    main_activity = next(
        (
            element
            for element in app.findall("activity")
            if element.get(android_attribute("name"), "").endswith("MainActivity")
        ),
        None,
    )
    if main_activity is None:
        raise RuntimeError(f"No MainActivity found in {manifest_path}")
    for data in main_activity.findall("intent-filter/data"):
        if data.get(android_attribute("host")) == "auth" and data.get(android_attribute("scheme")) in (LEGACY_APPLICATION_ID, "app.primeops.mobile"):
            data.set(android_attribute("scheme"), APPLICATION_ID)

    has_auth_filter = any(
        any(
            data.get(android_attribute("scheme")) == APPLICATION_ID
            and data.get(android_attribute("host")) == "auth"
            for data in intent_filter.findall("data")
        )
        for intent_filter in main_activity.findall("intent-filter")
    )
    if not has_auth_filter:
        intent_filter = ET.SubElement(main_activity, "intent-filter")
        ET.SubElement(
            intent_filter,
            "action",
            {android_attribute("name"): "android.intent.action.VIEW"},
        )
        ET.SubElement(
            intent_filter,
            "category",
            {android_attribute("name"): "android.intent.category.DEFAULT"},
        )
        ET.SubElement(
            intent_filter,
            "category",
            {android_attribute("name"): "android.intent.category.BROWSABLE"},
        )
        ET.SubElement(
            intent_filter,
            "data",
            {
                android_attribute("scheme"): APPLICATION_ID,
                android_attribute("host"): "auth",
            },
        )

    camera_activity = next(
        (
            element
            for element in app.findall("activity")
            if element.get(android_attribute("name")) == ".CameraCaptureActivity"
        ),
        None,
    )
    if camera_activity is None:
        camera_activity = ET.SubElement(app, "activity")
    camera_activity.set(android_attribute("name"), ".CameraCaptureActivity")
    camera_activity.set(android_attribute("exported"), "false")
    camera_activity.set(android_attribute("screenOrientation"), "portrait")

    ET.indent(tree, space="    ")
    tree.write(manifest_path, encoding="utf-8", xml_declaration=True)


def main():
    java_source = ROOT / "android-src"
    java_root = ROOT / "android/app/src/main/java"
    for existing in java_root.rglob("*.java"):
        if existing.name in {p.name for p in java_source.glob("*.java")}:
            existing.unlink()
    java_destination = java_root / APPLICATION_ID.replace(".", "/")
    java_destination.mkdir(parents=True, exist_ok=True)
    for filename in (
        "LightSensorPlugin.java",
        "CameraCapturePlugin.java",
        "CameraCaptureActivity.java",
        "PdfReportPlugin.java",
        "CheckLocationPlugin.java",
        "AppUpdatesPlugin.java",
        "SupplierEmailPlugin.java",
        "MainActivity.java",
    ):
        source = (java_source / filename).read_text(encoding="utf-8")
        (java_destination / filename).write_text(source.replace("package app.primeops.mobile;", f"package {APPLICATION_ID};"), encoding="utf-8")

    shutil.copytree(ROOT / "android-res", ROOT / "android/app/src/main/res", dirs_exist_ok=True)

    manifest_path = ROOT / "android/app/src/main/AndroidManifest.xml"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"Android manifest not found: {manifest_path}")
    patch_manifest(manifest_path)

    app_gradle = ROOT / "android/app/build.gradle"
    gradle_text = app_gradle.read_text(encoding="utf-8")
    gradle_text = re.sub(r'(namespace|applicationId) "[^"]+"', lambda match: f'{match.group(1)} "{APPLICATION_ID}"', gradle_text)
    if "ANDROID_VERSION_CODE" in os.environ:
        version_code = int(os.environ["ANDROID_VERSION_CODE"])
        if not 1 <= version_code <= 2100000000:
            raise ValueError("Invalid Android version code")
        gradle_text = re.sub(r"versionCode \d+", f"versionCode {version_code}", gradle_text)
    if "ANDROID_VERSION_NAME" in os.environ:
        version_name = os.environ["ANDROID_VERSION_NAME"]
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", version_name):
            raise ValueError("Invalid Android version name")
        gradle_text = re.sub(r'versionName "[^"]+"', f'versionName "{version_name}"', gradle_text)
    camera_dependencies = (
        "    implementation 'androidx.camera:camera-camera2:1.3.4'\n"
        "    implementation 'androidx.camera:camera-lifecycle:1.3.4'\n"
        "    implementation 'androidx.camera:camera-view:1.3.4'\n"
    )
    if "androidx.camera:camera-camera2" not in gradle_text:
        marker = "dependencies {\n"
        if marker not in gradle_text:
            raise RuntimeError(f"No dependencies block found in {app_gradle}")
        gradle_text = gradle_text.replace(marker, marker + camera_dependencies, 1)
    gradle_text = gradle_text.replace("!*.test.*:", "")
    if "!*.test.mjs" not in gradle_text:
        marker = "ignoreAssetsPattern '"
        if marker not in gradle_text:
            raise RuntimeError(f"No asset ignore pattern found in {app_gradle}")
        gradle_text = gradle_text.replace(marker, marker + "!*.test.mjs:!*.test.js:!*.test.cjs:", 1)
    app_gradle.write_text(gradle_text, encoding="utf-8")
    strings = ROOT / "android/app/src/main/res/values/strings.xml"
    strings.write_text(f'''<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">{APP_NAME}</string>
    <string name="title_activity_main">{APP_NAME}</string>
    <string name="package_name">{APPLICATION_ID}</string>
    <string name="custom_url_scheme">{APPLICATION_ID}</string>
</resources>
''', encoding="utf-8")


if __name__ == "__main__":
    main()