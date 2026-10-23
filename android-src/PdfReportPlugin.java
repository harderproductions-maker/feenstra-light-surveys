package com.feenstra.lightsurveys;

import android.content.Context;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintJob;
import android.print.PrintManager;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "PdfReport")
public class PdfReportPlugin extends Plugin {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final List<WebView> activeViews = new ArrayList<>();

    @PluginMethod
    public void create(PluginCall call) {
        String html = call.getString("html");
        String title = call.getString("title", "FG Ops Report");
        if (html == null || html.isEmpty()) {
            call.reject("Report content is empty.");
            return;
        }
        getActivity().runOnUiThread(() -> renderAndPrint(call, html, title));
    }

    private void renderAndPrint(PluginCall call, String html, String title) {
        WebView webView = new WebView(getContext());
        webView.setBackgroundColor(Color.WHITE);
        webView.getSettings().setJavaScriptEnabled(false);
        webView.getSettings().setBlockNetworkLoads(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(false);
        activeViews.add(webView);
        getActivity().addContentView(
            webView,
            new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        );
        webView.setVisibility(View.INVISIBLE);
        webView.setWebViewClient(new WebViewClient() {
            private final AtomicBoolean printStarted = new AtomicBoolean(false);

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!printStarted.compareAndSet(false, true)) return;
                PrintManager printManager = (PrintManager) getContext().getSystemService(Context.PRINT_SERVICE);
                if (printManager == null) {
                    call.reject("Android PDF printing is unavailable on this device.");
                    cleanup(webView);
                    return;
                }
                try {
                    PrintAttributes attributes = new PrintAttributes.Builder()
                        .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                        .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
                        .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                        .build();
                    PrintJob job = printManager.print(
                        title,
                        view.createPrintDocumentAdapter(title),
                        attributes
                    );
                    if (job == null) {
                        call.reject("Android did not start the PDF print job.");
                        cleanup(webView);
                        return;
                    }
                    call.resolve();
                    monitorJob(job, webView, System.currentTimeMillis());
                } catch (RuntimeException error) {
                    call.reject("Could not open Android's PDF export screen.", error);
                    cleanup(webView);
                }
            }
        });
        webView.loadDataWithBaseURL("https://localhost/", html, "text/html", "UTF-8", null);
    }

    private void monitorJob(PrintJob job, WebView webView, long startedAt) {
        handler.postDelayed(() -> {
            boolean finished = job.isCompleted() || job.isCancelled() || job.isFailed();
            boolean timedOut = System.currentTimeMillis() - startedAt > 15 * 60 * 1000;
            if (finished || timedOut) {
                cleanup(webView);
            } else {
                monitorJob(job, webView, startedAt);
            }
        }, 5000);
    }

    private void cleanup(WebView webView) {
        activeViews.remove(webView);
        ViewGroup parent = (ViewGroup) webView.getParent();
        if (parent != null) parent.removeView(webView);
        webView.stopLoading();
        webView.destroy();
    }

    @Override
    protected void handleOnDestroy() {
        handler.removeCallbacksAndMessages(null);
        for (WebView webView : new ArrayList<>(activeViews)) cleanup(webView);
        super.handleOnDestroy();
    }
}
