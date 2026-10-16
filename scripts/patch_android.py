from pathlib import Path
import shutil
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
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

    app = manifest.find("application")
    if app is None:
        raise RuntimeError(f"No <application> element found in {manifest_path}")

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

    has_auth_filter = any(
        any(
            data.get(android_attribute("scheme")) == "com.feenstra.lightsurveys"
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
                android_attribute("scheme"): "com.feenstra.lightsurveys",
                android_attribute("host"): "auth",
            },
        )

    ET.indent(tree, space="    ")
    tree.write(manifest_path, encoding="utf-8", xml_declaration=True)


def main():
    java_source = ROOT / "android-src"
    java_destination = ROOT / "android/app/src/main/java/com/feenstra/lightsurveys"
    java_destination.mkdir(parents=True, exist_ok=True)
    for filename in ("LightSensorPlugin.java", "MainActivity.java"):
        shutil.copy2(java_source / filename, java_destination / filename)

    manifest_path = ROOT / "android/app/src/main/AndroidManifest.xml"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"Android manifest not found: {manifest_path}")
    patch_manifest(manifest_path)


if __name__ == "__main__":
    main()