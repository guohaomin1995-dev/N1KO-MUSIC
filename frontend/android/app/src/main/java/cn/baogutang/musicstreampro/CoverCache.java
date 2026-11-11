package cn.baogutang.musicstreampro;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.net.URLDecoder;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * 封面的本机磁盘缓存，挂在 WebDavProxy 上。
 *
 * 有的服务端不认 getCoverArt 的 size 参数，要一张 64px 的缩略图也回整张原图（实测 190KB 左右），
 * 远程连回家里时一页几十张封面要等好几秒，而且每次打开都重新下。
 * 这里第一次下完就按请求的尺寸缩小存起来（128px 的列表封面只剩十几 KB），之后直接从本地给，
 * 返回时带长期缓存头，WebView 自己也会再缓存一层。
 *
 * 缓存键去掉了认证参数（u / t / s / p）和格式参数，只认「哪台服务器、哪张图、多大」。
 * 放在系统缓存目录：空间紧张时系统可以清掉，清掉了只是重新下载。超过上限按最久没用的先删。
 */
final class CoverCache {
    private static final long MAX_BYTES = 200L * 1024 * 1024;
    private static final int TRIM_EVERY = 40;
    private static final List<String> VOLATILE_PARAMS = Arrays.asList("u", "t", "s", "p", "v", "c", "f");

    private static volatile File dir;
    private static final ConcurrentHashMap<String, Object> inflight = new ConcurrentHashMap<>();
    private static final AtomicInteger writes = new AtomicInteger();

    private CoverCache() {}

    static void init(File cacheRoot) {
        if (cacheRoot == null) return;
        File d = new File(cacheRoot, "covers");
        if (d.isDirectory() || d.mkdirs()) dir = d;
    }

    /** 只缓存 Subsonic 的封面和头像；音频流照旧直接转发 */
    static boolean handles(String target) {
        try {
            String path = new URL(target).getPath();
            return path.endsWith("/rest/getCoverArt") || path.endsWith("/rest/getCoverArt.view")
                || path.endsWith("/rest/getAvatar") || path.endsWith("/rest/getAvatar.view");
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 拿一张封面：先看本地，没有就下载、缩小、存好再给。
     * 返回 null 表示这张不适合缓存（不是图片、服务器出错），调用方按原样转发。
     */
    static byte[] get(String target) throws IOException {
        File d = dir;
        if (d == null) return null;
        String key = keyOf(target);
        if (key == null) return null;
        File file = new File(d, key);
        byte[] hit = readIfPresent(file);
        if (hit != null) return hit;

        // 同一张图同时被要好几次（列表和播放条一起要）：只下载一次，其余等它
        Object lock = inflight.computeIfAbsent(key, k -> new Object());
        synchronized (lock) {
            try {
                hit = readIfPresent(file);
                if (hit != null) return hit;
                byte[] raw = download(target);
                if (raw == null) return null;
                byte[] stored = shrink(raw, requestedSize(target));
                File tmp = new File(d, key + ".tmp");
                try (FileOutputStream out = new FileOutputStream(tmp)) {
                    out.write(stored);
                }
                if (!tmp.renameTo(file)) {
                    //noinspection ResultOfMethodCallIgnored
                    tmp.delete();
                }
                if (writes.incrementAndGet() % TRIM_EVERY == 0) trim(d);
                return stored;
            } finally {
                inflight.remove(key);
            }
        }
    }

    /** 按文件头认图片格式，好写对 Content-Type */
    static String mimeOf(byte[] data) {
        if (data.length >= 3 && (data[0] & 0xff) == 0xFF && (data[1] & 0xff) == 0xD8) return "image/jpeg";
        if (data.length >= 8 && (data[0] & 0xff) == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G') return "image/png";
        if (data.length >= 4 && data[0] == 'G' && data[1] == 'I' && data[2] == 'F') return "image/gif";
        if (data.length >= 12 && data[0] == 'R' && data[1] == 'I' && data[2] == 'F' && data[3] == 'F'
            && data[8] == 'W' && data[9] == 'E' && data[10] == 'B' && data[11] == 'P') return "image/webp";
        return "image/jpeg";
    }

    private static byte[] readIfPresent(File file) {
        if (!file.isFile() || file.length() == 0) return null;
        try (InputStream in = new FileInputStream(file)) {
            byte[] data = new byte[(int) file.length()];
            int off = 0;
            while (off < data.length) {
                int n = in.read(data, off, data.length - off);
                if (n < 0) break;
                off += n;
            }
            if (off != data.length) return null;
            // 按最近使用排序，裁剪时先删最久没看过的
            //noinspection ResultOfMethodCallIgnored
            file.setLastModified(System.currentTimeMillis());
            return data;
        } catch (IOException e) {
            return null;
        }
    }

    private static byte[] download(String target) throws IOException {
        try (Response response = WebDavAuth.allows(target)
            ? WebDavAuth.openAuthorized(target, null)
            : WebDavAuth.openDirect(target, null)) {
            if (response.code() != 200) return null;
            String type = response.header("Content-Type");
            // 失败时有的服务端回 200 + JSON / XML 错误体，不能当成图存下来
            if (type != null && !type.toLowerCase(Locale.US).startsWith("image/")) return null;
            ResponseBody body = response.body();
            if (body == null) return null;
            byte[] raw = body.bytes();
            return raw.length > 0 ? raw : null;
        }
    }

    /** 按请求的尺寸缩小（最长边），编码成 JPEG；有透明通道的保留 PNG。缩不了就存原图 */
    static byte[] shrink(byte[] raw, int size) {
        if (size <= 0) return raw;
        int edge = Math.max(64, Math.min(size, 1200));
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(raw, 0, raw.length, bounds);
        int w = bounds.outWidth;
        int h = bounds.outHeight;
        if (w <= 0 || h <= 0) return raw;
        if (Math.max(w, h) <= edge * 1.15) return raw;
        BitmapFactory.Options opts = new BitmapFactory.Options();
        int sample = 1;
        while (Math.max(w, h) / (sample * 2) >= edge) sample *= 2;
        opts.inSampleSize = sample;
        Bitmap decoded = BitmapFactory.decodeByteArray(raw, 0, raw.length, opts);
        if (decoded == null) return raw;
        float scale = (float) edge / Math.max(decoded.getWidth(), decoded.getHeight());
        Bitmap scaled = scale < 1f
            ? Bitmap.createScaledBitmap(decoded, Math.max(1, Math.round(decoded.getWidth() * scale)), Math.max(1, Math.round(decoded.getHeight() * scale)), true)
            : decoded;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        boolean png = scaled.hasAlpha();
        scaled.compress(png ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG, 86, out);
        if (scaled != decoded) scaled.recycle();
        decoded.recycle();
        byte[] small = out.toByteArray();
        return small.length > 0 && small.length < raw.length ? small : raw;
    }

    static int requestedSize(String target) {
        String value = param(target, "size");
        if (value == null) return 0;
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** 服务器 + 路径 + 去掉认证参数后排好序的查询串，再取 SHA-1 当文件名 */
    static String keyOf(String target) {
        try {
            URL url = new URL(target);
            List<String> kept = new ArrayList<>();
            String q = url.getQuery();
            if (q != null) {
                for (String pair : q.split("&")) {
                    int eq = pair.indexOf('=');
                    String name = URLDecoder.decode(eq < 0 ? pair : pair.substring(0, eq), "UTF-8");
                    if (VOLATILE_PARAMS.contains(name)) continue;
                    kept.add(pair);
                }
            }
            Collections.sort(kept);
            String identity = url.getProtocol() + "://" + url.getAuthority() + url.getPath() + "?" + String.join("&", kept);
            MessageDigest sha = MessageDigest.getInstance("SHA-1");
            byte[] digest = sha.digest(identity.getBytes("UTF-8"));
            StringBuilder hex = new StringBuilder();
            for (byte b : digest) hex.append(String.format(Locale.US, "%02x", b));
            return hex.toString();
        } catch (Exception e) {
            return null;
        }
    }

    private static String param(String target, String key) {
        try {
            String q = new URL(target).getQuery();
            if (q == null) return null;
            for (String pair : q.split("&")) {
                int eq = pair.indexOf('=');
                if (eq < 0) continue;
                if (key.equals(URLDecoder.decode(pair.substring(0, eq), "UTF-8"))) {
                    return URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    /** 超过上限就按最近使用时间从旧到新删，删到上限的八成 */
    private static void trim(File d) {
        File[] files = d.listFiles();
        if (files == null) return;
        long total = 0;
        for (File f : files) total += f.length();
        if (total <= MAX_BYTES) return;
        Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        long target = (long) (MAX_BYTES * 0.8);
        for (File f : files) {
            if (total <= target) break;
            long len = f.length();
            if (f.delete()) total -= len;
        }
    }
}
