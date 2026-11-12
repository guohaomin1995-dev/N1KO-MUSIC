package cn.baogutang.musicstreampro;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 应用内更新：在 App 里下载新版安装包（带进度），下完交给系统安装器覆盖安装。
 *
 * 以前是把下载地址丢给浏览器：下完还得自己去下载列表里找到安装包点开。现在：
 * - download：后台线程下载到缓存目录 updates/，边下边发 progress 事件；只认 GitHub 的地址
 *   （github.com 跳到 *.githubusercontent.com），每一跳都检查，不下别处的东西；
 *   同一个文件已经完整下过（大小对得上）就直接用；
 * - install：先核对安装包是不是本 App、版本号是不是更高，再拉起系统安装界面。
 *   Android 8 起每个 App 要单独被允许「安装未知应用」；没允许时打开那个设置页，
 *   返回 needs-permission，用户打开开关回来后由界面再调一次 install。
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    private static final String DIR = "updates";
    private static final int MAX_REDIRECTS = 5;
    private static final long PROGRESS_INTERVAL_MS = 150;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private volatile boolean cancelled = false;
    private volatile HttpURLConnection active = null;

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String fileName = call.getString("fileName");
        long expectedSize = call.getLong("expectedSize", 0L);
        if (url == null || !isAllowedUrl(url)) {
            call.reject("只能从 GitHub 下载安装包", "BAD_INPUT");
            return;
        }
        if (fileName == null || !fileName.matches("[A-Za-z0-9._-]+\\.apk")) {
            call.reject("安装包文件名不对", "BAD_INPUT");
            return;
        }
        cancelled = false;
        executor.execute(() -> runDownload(call, url, fileName, expectedSize));
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        cancelled = true;
        HttpURLConnection connection = active;
        if (connection != null) connection.disconnect();
        call.resolve();
    }

    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject result = new JSObject();
        result.put("allowed", installAllowed());
        call.resolve(result);
    }

    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        File dir = updatesDir();
        File file = path == null ? null : new File(path);
        try {
            if (file == null || !file.isFile() || !file.getCanonicalFile().getParentFile().equals(dir.getCanonicalFile())) {
                call.reject("找不到下载好的安装包", "NOT_FOUND");
                return;
            }
        } catch (IOException e) {
            call.reject("找不到下载好的安装包", "NOT_FOUND");
            return;
        }

        Context context = getContext();
        PackageManager pm = context.getPackageManager();
        PackageInfo archive = pm.getPackageArchiveInfo(file.getAbsolutePath(), 0);
        if (archive == null || !context.getPackageName().equals(archive.packageName)) {
            file.delete();
            call.reject("下载的文件不是 X-MUSIC 的安装包", "BAD_PACKAGE");
            return;
        }
        try {
            PackageInfo installed = pm.getPackageInfo(context.getPackageName(), 0);
            long archiveCode = versionCodeOf(archive);
            long installedCode = versionCodeOf(installed);
            // 调试包放宽到「同版本号也能装」：开发时要拿已发布的同版本安装包把整条链路走一遍
            boolean debuggable = (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
            if (archiveCode < installedCode || (archiveCode == installedCode && !debuggable)) {
                call.reject("安装包的版本不比现在的新", "NOT_NEWER");
                return;
            }
        } catch (PackageManager.NameNotFoundException ignored) {
            // 自己查不到自己不可能发生；真发生了就交给系统安装器去判断
        }

        JSObject result = new JSObject();
        if (!installAllowed()) {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + context.getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(settings);
            result.put("status", "needs-permission");
            call.resolve(result);
            return;
        }

        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        context.startActivity(intent);
        result.put("status", "started");
        call.resolve(result);
    }

    // ---------------------------------------------------------------- 下载

    private void runDownload(PluginCall call, String url, String fileName, long expectedSize) {
        File dir = updatesDir();
        File target = new File(dir, fileName);
        if (expectedSize > 0 && target.isFile() && target.length() == expectedSize) {
            resolveDownloaded(call, target);
            return;
        }
        // 只留这一个：旧版本的安装包、上次没下完的半截都清掉
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) f.delete();
        File part = new File(dir, fileName + ".part");

        HttpURLConnection connection = null;
        try {
            connection = openFollowingRedirects(url);
            active = connection;
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                call.reject("下载失败（HTTP " + status + "）", "HTTP_" + status);
                return;
            }
            long total = connection.getContentLengthLong();
            if (total <= 0) total = expectedSize;
            long received = 0;
            long lastEmit = 0;
            byte[] buffer = new byte[64 * 1024];
            try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                int n;
                while ((n = in.read(buffer)) != -1) {
                    if (cancelled) throw new CancelledException();
                    out.write(buffer, 0, n);
                    received += n;
                    long now = System.currentTimeMillis();
                    if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
                        lastEmit = now;
                        emitProgress(received, total);
                    }
                }
            }
            if (cancelled) throw new CancelledException();
            if (expectedSize > 0 && received != expectedSize) {
                part.delete();
                call.reject("下载不完整，请重试", "SIZE_MISMATCH");
                return;
            }
            emitProgress(received, total);
            if (!part.renameTo(target)) {
                part.delete();
                call.reject("保存安装包失败", "WRITE_FAILED");
                return;
            }
            resolveDownloaded(call, target);
        } catch (CancelledException e) {
            part.delete();
            call.reject("已取消下载", "CANCELLED");
        } catch (IOException e) {
            part.delete();
            if (cancelled) {
                call.reject("已取消下载", "CANCELLED");
            } else {
                call.reject("网络中断：" + e.getMessage(), "NETWORK");
            }
        } finally {
            active = null;
            if (connection != null) connection.disconnect();
        }
    }

    /** 自己跟重定向：每一跳都必须还在 GitHub 的地盘上 */
    private HttpURLConnection openFollowingRedirects(String start) throws IOException {
        String current = start;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (!isAllowedUrl(current)) throw new IOException("跳转到了 GitHub 以外的地址");
            HttpURLConnection connection = (HttpURLConnection) new URL(current).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(30_000);
            connection.setRequestProperty("User-Agent", "X-MUSIC-Updater");
            connection.setRequestProperty("Accept", "application/octet-stream");
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) {
                String location = connection.getHeaderField("Location");
                connection.disconnect();
                if (location == null) throw new IOException("重定向没有目标地址");
                current = new URL(new URL(current), location).toString();
                continue;
            }
            return connection;
        }
        throw new IOException("重定向次数太多");
    }

    private static boolean isAllowedUrl(String url) {
        try {
            URL parsed = new URL(url);
            if (!"https".equals(parsed.getProtocol())) return false;
            String host = parsed.getHost().toLowerCase(Locale.ROOT);
            return host.equals("github.com")
                || host.endsWith(".github.com")
                || host.equals("githubusercontent.com")
                || host.endsWith(".githubusercontent.com");
        } catch (IOException e) {
            return false;
        }
    }

    private void emitProgress(long received, long total) {
        JSObject data = new JSObject();
        data.put("received", received);
        data.put("total", total);
        notifyListeners("progress", data);
    }

    private void resolveDownloaded(PluginCall call, File file) {
        JSObject result = new JSObject();
        result.put("path", file.getAbsolutePath());
        result.put("size", file.length());
        call.resolve(result);
    }

    private File updatesDir() {
        File dir = new File(getContext().getCacheDir(), DIR);
        if (!dir.isDirectory()) dir.mkdirs();
        return dir;
    }

    private boolean installAllowed() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        return getContext().getPackageManager().canRequestPackageInstalls();
    }

    @SuppressWarnings("deprecation")
    private static long versionCodeOf(PackageInfo info) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
    }

    private static final class CancelledException extends IOException {
        CancelledException() { super("cancelled"); }
    }
}
