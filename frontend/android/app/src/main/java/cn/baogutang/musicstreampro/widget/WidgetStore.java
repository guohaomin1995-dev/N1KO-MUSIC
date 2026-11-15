package cn.baogutang.musicstreampro.widget;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;

/**
 * 桌面小部件要显示的东西，存在本机：应用被系统收走以后，桌面重画小部件（开机、换壁纸、改大小）时
 * 网页那一侧已经不在了，只能从这里拿上一次的歌名、歌手和封面。
 */
final class WidgetStore {
    private static final String PREFS = "xmusic_widget";

    private WidgetStore() {}

    /** 播放位置最多凭时间往后推多久（两次对表之间正常只隔 5 秒） */
    static final long MAX_EXTRAPOLATE_MS = 12_000;

    static final class State {
        boolean hasSong;
        String title = "";
        String artist = "";
        /** 网页那一侧最后一次说的「在不在放」。应用不在了它可能还是 true，用的时候看 {@link HomeWidgetPlugin#isAlive()} */
        boolean playing;
        boolean starred;
        boolean canStar;
        long positionMs;
        /** positionMs 是哪一刻的（System.currentTimeMillis）：在放的时候按它往后推 */
        long positionAt;
        long durationMs;
        /** 播放速度：在放的时候进度按它往后推（倍速播客、有声书） */
        float rate = 1f;
        /** 网页那一侧要的是哪张封面：封面地址（去掉了每次都变的鉴权参数）的 SHA-256，见 {@link #coverKey} */
        String coverKey = "";
        /** 存在磁盘上的那张是哪张（同样是摘要）；和 coverKey 不一样说明新的还在下，或者没下下来 */
        String coverFileKey = "";
        /** 背景有多实：0 全透明，100 不透明 */
        int opacity = 85;

        long positionNow(boolean reallyPlaying) {
            long pos = positionMs;
            if (reallyPlaying && positionAt > 0) {
                // 网页那一侧每 5 秒对一次表；很久没来对（卡在缓冲、页面被系统冻住），就别再凭空往后推了
                long since = Math.max(0, System.currentTimeMillis() - positionAt);
                pos += Math.round(Math.min(since, MAX_EXTRAPOLATE_MS) * rate);
            }
            if (durationMs > 0) pos = Math.min(pos, durationMs);
            return Math.max(0, pos);
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static State read(Context context) {
        SharedPreferences p = prefs(context);
        migrate(p);
        State s = new State();
        s.hasSong = p.getBoolean("hasSong", false);
        s.title = p.getString("title", "");
        s.artist = p.getString("artist", "");
        s.playing = p.getBoolean("playing", false);
        s.starred = p.getBoolean("starred", false);
        s.canStar = p.getBoolean("canStar", false);
        s.positionMs = p.getLong("positionMs", 0);
        s.positionAt = p.getLong("positionAt", 0);
        s.durationMs = p.getLong("durationMs", 0);
        s.rate = p.getFloat("rate", 1f);
        s.coverKey = p.getString("coverKey", "");
        s.coverFileKey = p.getString("coverFileKey", "");
        s.opacity = p.getInt("opacity", 85);
        return s;
    }

    static void write(Context context, State s) {
        prefs(context).edit()
            .putBoolean("hasSong", s.hasSong)
            .putString("title", s.title)
            .putString("artist", s.artist)
            .putBoolean("playing", s.playing)
            .putBoolean("starred", s.starred)
            .putBoolean("canStar", s.canStar)
            .putLong("positionMs", s.positionMs)
            .putLong("positionAt", s.positionAt)
            .putLong("durationMs", s.durationMs)
            .putFloat("rate", s.rate)
            .putString("coverKey", s.coverKey)
            .apply();
    }

    /** 速度只认 0.25–4 倍，别的（没给、给错）按 1 倍 */
    static float clampRate(double rate) {
        if (!(rate > 0) || Double.isInfinite(rate)) return 1f;
        return (float) Math.max(0.25, Math.min(4, rate));
    }

    /**
     * 存下来的封面 key：只比相等，所以存地址的摘要就够了。Jellyfin / Emby 的封面地址里带着登录令牌（api_key），
     * 原样存进本机文件不妥。空串（没有封面）还是空串。
     */
    static String coverKey(String identity) {
        if (identity == null || identity.isEmpty()) return "";
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(identity.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) hex.append(String.format(Locale.US, "%02x", b));
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            // 每台安卓设备都有 SHA-256；真没有的话宁可当没有封面，也不存原样的地址
            return "";
        }
    }

    private static final int VERSION = 2;
    private static volatile boolean migrated;

    /**
     * 第一版把封面地址原样存成 key（见 {@link #coverKey}）：清掉。封面那张图还在，等网页推来新的 key 再对上；
     * 应用没开的话小部件先画默认的玻璃，下次打开应用就回来了。
     */
    private static void migrate(SharedPreferences p) {
        if (migrated) return;
        synchronized (WidgetStore.class) {
            if (migrated) return;
            if (p.getInt("version", 1) < VERSION) {
                p.edit().remove("coverKey").remove("coverFileKey").putInt("version", VERSION).apply();
            }
            migrated = true;
        }
    }

    /* 下面两项各有各的写入口，不跟着 write 走：封面是后台线程下完才写的，
       和 write 混在一起的话，一次「读出来、改几项、写回去」会把刚下好的那张标回旧的 */

    static void setCoverFileKey(Context context, String key) {
        prefs(context).edit().putString("coverFileKey", key).apply();
    }

    static void setOpacity(Context context, int opacity) {
        prefs(context).edit().putInt("opacity", Math.max(0, Math.min(100, opacity))).apply();
    }

    /** 当前封面存在这里（一张缩好的 JPEG）。放在 files 而不是 cache：系统清缓存以后小部件不该变成没封面 */
    static File coverFile(Context context) {
        File dir = new File(context.getApplicationContext().getFilesDir(), "widget");
        if (!dir.isDirectory()) dir.mkdirs();
        return new File(dir, "cover.jpg");
    }

    /** 1:23 / 1:02:03 */
    static String clock(long ms) {
        long total = Math.max(0, ms) / 1000;
        long hours = total / 3600;
        long minutes = (total % 3600) / 60;
        long seconds = total % 60;
        return hours > 0
            ? String.format(Locale.US, "%d:%02d:%02d", hours, minutes, seconds)
            : String.format(Locale.US, "%d:%02d", minutes, seconds);
    }
}
