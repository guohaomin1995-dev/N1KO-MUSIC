package cn.baogutang.musicstreampro;

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import java.io.IOException;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 应用内的插件要在 super.onCreate 建桥之前注册
        registerPlugin(WebDavPlugin.class);
        registerPlugin(GalleryPlugin.class);
        registerPlugin(AppUpdaterPlugin.class);
        registerPlugin(TvModePlugin.class);
        CoverCache.init(getCacheDir());
        try {
            WebDavProxy.ensureStarted();
        } catch (IOException ignored) {
        }
        super.onCreate(savedInstanceState);
        installWebDavClient();

        /*
         * 电视：让网页里的 <meta name="viewport" content="width=960"> 生效。
         * 各家电视盒子的屏幕密度从 1 到 2 都有，同一套界面有的电视上正常、有的只有一半大；
         * 网页（src/components/tv/TvModeEffects.tsx）把布局视口钉在 960 宽，WebView 按屏幕宽度缩放。
         * WebView 默认不认 viewport 的 width，要先打开宽视口。
         */
        if (TvModePlugin.detect(this) && getBridge() != null && getBridge().getWebView() != null) {
            WebSettings settings = getBridge().getWebView().getSettings();
            settings.setUseWideViewPort(true);
            settings.setLoadWithOverviewMode(true);
        }
    }

    @Override
    public void onStart() {
        super.onStart();
        // 桥接层有时会在启动后再装自己的 WebViewClient，认证拦截要盖在那之后。
        installWebDavClient();
    }

    private void installWebDavClient() {
        if (getBridge() == null) return;
        WebView view = getBridge().getWebView();
        if (view == null) return;
        if (Build.VERSION.SDK_INT >= 26 && alreadyInstalled(view)) return;
        view.setWebViewClient(new WebDavWebViewClient(getBridge()));
    }

    @android.annotation.TargetApi(26)
    private static boolean alreadyInstalled(WebView view) {
        return view.getWebViewClient() instanceof WebDavWebViewClient;
    }
}
