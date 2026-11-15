package cn.baogutang.musicstreampro.widget;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.SystemClock;
import android.util.Base64;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSource;

/**
 * 小部件的封面：网页那一侧给一个地址（服务器封面是 http 地址，钉住的图、自定义封面是 data: 图片），
 * 这里下载、缩到够用的大小，存成一张 JPEG。应用不在了以后小部件还要靠这张图重画。
 *
 * 下载交给 OkHttp 自己的线程，换歌时把还没下完的那个取消：一个卡住的封面地址（连不上、DNS 卡着）
 * 不会拖住下一首的封面。解码和存盘在一个单独的线程里排队做。
 * 下不下来的封面隔一阵再试几次（网页那一侧同一首歌不会再发一遍地址，只能这边记着）。
 */
final class WidgetCovers {
    /** 存多大：大号小部件上的封面，手机上约 500 像素，平板上 600 多 */
    private static final int MAX_SIZE = 640;
    /** 再大的图不下：正常的封面没有这么大 */
    private static final long MAX_BYTES = 12L * 1024 * 1024;
    /** 下不下来时隔多久再试；试完这几次就算了，等换歌 */
    private static final long[] RETRY_AFTER_MS = { 5_000, 15_000, 45_000 };

    private static final ExecutorService worker = Executors.newSingleThreadExecutor();
    private static final OkHttpClient http = new OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        // 一次下载从头到尾最多这么久，不会一直占着连接
        .callTimeout(12, TimeUnit.SECONDS)
        .build();

    private static Bitmap memory;
    private static String memoryKey = "";
    /** 最后一次要的是哪张：下载回来时已经换歌了就不用它 */
    private static volatile String wanted = "";
    /** 正在下的那个，换歌时取消 */
    private static volatile Call inFlight;

    /* 重试用：只在内存里记最后一张的地址（data: 图片很大，不进存储） */
    private static String lastSource = "";
    private static String lastKey = "";
    private static boolean loading;
    private static int failures;
    private static long retryAt;

    private WidgetCovers() {}

    /** 手上这张封面（key 要对得上）；没有就是 null，小部件画默认的玻璃和占位图 */
    static synchronized Bitmap current(Context context, String fileKey) {
        if (fileKey == null || fileKey.isEmpty()) return null;
        if (memory != null && fileKey.equals(memoryKey)) return memory;
        File file = WidgetStore.coverFile(context);
        if (!file.isFile()) return null;
        Bitmap bitmap = BitmapFactory.decodeFile(file.getPath());
        if (bitmap == null) return null;
        memory = bitmap;
        memoryKey = fileKey;
        return bitmap;
    }

    /** 这首歌没有封面：把存着的那张清掉 */
    static synchronized void clear(Context context) {
        wanted = "";
        cancelInFlight();
        lastSource = "";
        lastKey = "";
        loading = false;
        dropStored(context);
    }

    private static synchronized void dropStored(Context context) {
        memory = null;
        memoryKey = "";
        File file = WidgetStore.coverFile(context);
        if (file.isFile()) file.delete();
        WidgetStore.setCoverFileKey(context, "");
    }

    /**
     * 换封面。好了（或者下不下来）之后调 done，由它重画小部件。
     * 新的没到之前旧封面先留着：局域网里一两百毫秒就到，中间闪一下默认图反而难看。
     */
    static void load(Context context, String source, String key, Runnable done) {
        synchronized (WidgetCovers.class) {
            if (!key.equals(lastKey)) {
                failures = 0;
                retryAt = 0;
            }
            lastSource = source;
            lastKey = key;
            loading = true;
        }
        start(context.getApplicationContext(), source, key, done);
    }

    /**
     * 上次没下下来的那张，到时候了就再试一次。网页那一侧正在放的时候每 5 秒推一次状态，顺带叫这里，
     * 不用另开定时器；没到时候、试够了、正在下、或者要的已经不是这张，都什么也不做。
     */
    static void retryIfDue(Context context, String key, Runnable done) {
        String source;
        synchronized (WidgetCovers.class) {
            if (loading || !key.equals(lastKey) || failures == 0 || failures > RETRY_AFTER_MS.length) return;
            if (SystemClock.elapsedRealtime() < retryAt) return;
            source = lastSource;
            if (!isHttp(source)) return;
            loading = true;
        }
        start(context.getApplicationContext(), source, key, done);
    }

    private static void start(Context app, String source, String key, Runnable done) {
        wanted = key;
        cancelInFlight();
        if (!isHttp(source)) {
            worker.execute(() -> finish(app, decodeInline(source), key, done));
            return;
        }
        Call call;
        try {
            call = http.newCall(new Request.Builder().url(source).build());
        } catch (IllegalArgumentException badUrl) {
            worker.execute(() -> finish(app, null, key, done));
            return;
        }
        inFlight = call;
        // 刚建好就换歌了：取消掉，不白下
        if (!key.equals(wanted)) {
            call.cancel();
            return;
        }
        call.enqueue(new Callback() {
            @Override
            public void onFailure(Call c, IOException e) {
                if (c.isCanceled()) return;
                worker.execute(() -> finish(app, null, key, done));
            }

            @Override
            public void onResponse(Call c, Response response) {
                byte[] raw = null;
                try (Response r = response) {
                    raw = readCapped(r);
                } catch (Exception ignored) {
                    // 读到一半断了：按没下下来处理
                }
                final byte[] bytes = raw;
                worker.execute(() -> finish(app, bytes == null ? null : decodeSquare(bytes), key, done));
            }
        });
    }

    private static void finish(Context app, Bitmap bitmap, String key, Runnable done) {
        synchronized (WidgetCovers.class) {
            if (key.equals(lastKey)) {
                loading = false;
                if (bitmap == null) {
                    retryAt = SystemClock.elapsedRealtime() + RETRY_AFTER_MS[Math.min(failures, RETRY_AFTER_MS.length - 1)];
                    failures++;
                } else {
                    failures = 0;
                }
            }
        }
        if (!key.equals(wanted)) return;
        if (bitmap == null) {
            dropStored(app);
        } else {
            store(app, bitmap, key);
        }
        done.run();
    }

    private static void cancelInFlight() {
        Call call = inFlight;
        inFlight = null;
        if (call != null) call.cancel();
    }

    private static boolean isHttp(String source) {
        return source.startsWith("http://") || source.startsWith("https://");
    }

    private static synchronized void store(Context context, Bitmap bitmap, String key) {
        try (FileOutputStream out = new FileOutputStream(WidgetStore.coverFile(context))) {
            bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out);
        } catch (Exception ignored) {
            // 存不下来也先用内存里这张
        }
        memory = bitmap;
        memoryKey = key;
        WidgetStore.setCoverFileKey(context, key);
    }

    private static byte[] readCapped(Response response) throws IOException {
        ResponseBody body = response.body();
        if (!response.isSuccessful() || body == null) return null;
        if (body.contentLength() > MAX_BYTES) return null;
        // 没报长度（分块传输）的响应也只读到上限为止：读得出上限加一个字节，就是超了
        BufferedSource stream = body.source();
        if (stream.request(MAX_BYTES + 1)) return null;
        byte[] raw = stream.getBuffer().readByteArray();
        return raw.length == 0 ? null : raw;
    }

    private static Bitmap decodeInline(String source) {
        if (!source.startsWith("data:")) return null;
        int comma = source.indexOf(',');
        if (comma < 0) return null;
        try {
            byte[] raw = Base64.decode(source.substring(comma + 1), Base64.DEFAULT);
            if (raw.length == 0 || raw.length > MAX_BYTES) return null;
            return decodeSquare(raw);
        } catch (IllegalArgumentException badBase64) {
            return null;
        }
    }

    /** 解码时先按 2 的倍数缩（省内存），再居中裁成正方形、缩到 MAX_SIZE 以内 */
    private static Bitmap decodeSquare(byte[] raw) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(raw, 0, raw.length, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
        int shortSide = Math.min(bounds.outWidth, bounds.outHeight);
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = 1;
        while (shortSide / (options.inSampleSize * 2) >= MAX_SIZE) options.inSampleSize *= 2;
        Bitmap decoded = BitmapFactory.decodeByteArray(raw, 0, raw.length, options);
        if (decoded == null) return null;
        int side = Math.min(decoded.getWidth(), decoded.getHeight());
        Bitmap square = Bitmap.createBitmap(decoded, (decoded.getWidth() - side) / 2, (decoded.getHeight() - side) / 2, side, side);
        if (side <= MAX_SIZE) return square;
        return Bitmap.createScaledBitmap(square, MAX_SIZE, MAX_SIZE, true);
    }
}
