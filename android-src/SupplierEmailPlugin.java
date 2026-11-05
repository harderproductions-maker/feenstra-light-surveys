package app.primeops.mobile;

import android.content.ClipData;
import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

@CapacitorPlugin(name = "SupplierEmail")
public class SupplierEmailPlugin extends Plugin {
    @PluginMethod
    public void compose(PluginCall call) {
        String to = call.getString("to", "");
        String bcc = call.getString("bcc", "");
        String subject = call.getString("subject", "");
        String text = call.getString("text", "");
        String html = call.getString("html", "");
        String filename = call.getString("filename", "Parts-quotation.html");
        if (!android.util.Patterns.EMAIL_ADDRESS.matcher(to).matches()
                || !android.util.Patterns.EMAIL_ADDRESS.matcher(bcc).matches()
                || to.contains("\n") || to.contains("\r") || bcc.contains("\n") || bcc.contains("\r")
                || html.isEmpty() || html.length() > 5 * 1024 * 1024
                || !filename.matches("[A-Za-z0-9_.-]+\\.html")) {
            call.reject("The quotation email or report attachment is invalid.");
            return;
        }
        try {
            File directory = new File(getContext().getCacheDir(), "supplier-quotes/" + UUID.randomUUID());
            if (!directory.mkdirs()) throw new IOException("Could not create quotation attachment directory.");
            File attachment = new File(directory, filename);
            try (FileOutputStream stream = new FileOutputStream(attachment)) {
                stream.write(html.getBytes(StandardCharsets.UTF_8));
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", attachment);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("message/rfc822");
            send.putExtra(Intent.EXTRA_EMAIL, new String[] { to });
            send.putExtra(Intent.EXTRA_BCC, new String[] { bcc });
            send.putExtra(Intent.EXTRA_SUBJECT, subject);
            send.putExtra(Intent.EXTRA_TEXT, text);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.setClipData(ClipData.newRawUri("Parts quotation report", uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().runOnUiThread(() -> {
                try {
                    getActivity().startActivity(Intent.createChooser(send, "Prepare supplier quotation email"));
                    call.resolve();
                } catch (ActivityNotFoundException error) {
                    call.reject("Install an email app to prepare this request.", error);
                } catch (RuntimeException error) {
                    call.reject("Could not open the email app.", error);
                }
            });
        } catch (IOException | IllegalArgumentException error) {
            call.reject("Could not prepare the parts report attachment.", error);
        }
    }
}
