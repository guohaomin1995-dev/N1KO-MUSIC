package cn.baogutang.musicstreampro.widget;

import android.annotation.TargetApi;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.ArrayMap;
import android.util.LruCache;
import android.util.SizeF;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import cn.baogutang.musicstreampro.MainActivity;
import cn.baogutang.musicstreampro.R;

/**
 * 把 {@link WidgetStore} 里的状态画到桌面上的小部件上。
 *
 * 小号（{@link SmallWidgetProvider}）：歌名、歌手、上一首 / 播放暂停 / 下一首、收藏。默认 2×2。
 * 大号（{@link LargeWidgetProvider}）：再加封面和进度条。默认 4×2。
 * 各种大小下怎么排见 {@link WidgetLayouts}：Android 12 起把所有排法一起交给桌面，由桌面按实际大小挑。
 *
 * 按钮怎么回到播放器：
 * - 正在放的时候应用一定活着，按钮发广播（{@link WidgetActionReceiver}），桌面上什么都不会动；
 * - 没在放的时候按钮打开一个看不见的中转页（{@link WidgetActionActivity}）：从暂停开播要应用在前台
 *   （后台拿不到音频焦点），应用已经被系统收走的话还得把界面打开，这两件事广播都做不稳。
 */
final class WidgetRenderer {
    static final String ACTION_TOGGLE = "cn.baogutang.musicstreampro.widget.TOGGLE";
    static final String ACTION_NEXT = "cn.baogutang.musicstreampro.widget.NEXT";
    static final String ACTION_PREVIOUS = "cn.baogutang.musicstreampro.widget.PREVIOUS";
    static final String ACTION_FAVORITE = "cn.baogutang.musicstreampro.widget.FAVORITE";
    /** 没在放就放（不是切换）：后台放不起来、把应用打开到前台时用 */
    static final String ACTION_PLAY = "cn.baogutang.musicstreampro.widget.PLAY";
    static final String ACTION_OPEN = "cn.baogutang.musicstreampro.widget.OPEN";

    /**
     * Android 12 起：
     * - 圆角交给桌面裁（布局根节点和封面都开了 clipToOutline），位图不带圆角，多大都不会虚；
     * - 所有排法一起交给桌面（{@code RemoteViews(Map<SizeF, RemoteViews>)}），桌面按小部件实际排出来的大小挑。
     *   桌面报给我们的大小靠不住——荣耀平板上 4×2 报 399×123dp，实际是 556×232dp——所以不依赖它。
     * 更老的系统只能按报的大小自己挑一种、自己画圆角。
     */
    private static final boolean SIZED = Build.VERSION.SDK_INT >= 31;
    /** 糊图最长的一边画多少像素：本来就是糊的，够平滑就行 */
    private static final int BACKDROP_SIDE = 360;
    /** 老系统：小部件的圆角、大号里封面的圆角（和 values/widget_dimens.xml 一致） */
    private static final float CORNER_DP = 24f;
    private static final float COVER_CORNER_DP = 14f;
    private static final float LEGACY_BACKGROUND_SIDE = 1000f;
    /** 封面位图最大边长（像素）：再大的屏幕上也够清楚了 */
    private static final int COVER_SIDE_CAP = 1024;
    private static final int PROGRESS_MAX = 1000;
    /** 背景比这还实（不透明度低于它）时，白色图标按钮身后垫一圈暗晕 */
    private static final int HALO_BELOW_OPACITY = 50;
    /** 背景全透明时压暗层有多深（0–1）；越实越浅，全实时为 0 */
    private static final float FLOOR_SCRIM = 0.22f;

    private static final Handler main = new Handler(Looper.getMainLooper());
    private static final LruCache<String, Bitmap> backgrounds = new LruCache<>(4);
    private static final LruCache<String, Bitmap> covers = new LruCache<>(2);
    private static final Map<String, PendingIntent> intents = new HashMap<>();
    private static volatile boolean ticking;
    private static volatile Context tickContext;

    private WidgetRenderer() {}

    /** 全部重画（带位图）。换歌、换封面、播放暂停、收藏、改透明度、桌面要求刷新时用 */
    static synchronized void renderAll(Context context) {
        Context app = context.getApplicationContext();
        AppWidgetManager manager = AppWidgetManager.getInstance(app);
        if (manager == null) return;
        int[] small = ids(app, manager, SmallWidgetProvider.class);
        int[] large = ids(app, manager, LargeWidgetProvider.class);
        boolean playing = false;
        if (small.length + large.length > 0) {
            WidgetStore.State state = WidgetStore.read(app);
            playing = state.playing && HomeWidgetPlugin.isAlive();
            Bitmap cover = WidgetCovers.current(app, state.coverFileKey);
            for (int id : small) manager.updateAppWidget(id, views(app, manager, id, false, state, playing, cover));
            for (int id : large) manager.updateAppWidget(id, views(app, manager, id, true, state, playing, cover));
        }
        setTicking(app, playing && large.length > 0);
    }

    /** 只有播放位置变了：不重画，只把进度条的计时对上 */
    static synchronized void syncTicker(Context context) {
        Context app = context.getApplicationContext();
        WidgetStore.State state = WidgetStore.read(app);
        boolean playing = state.playing && HomeWidgetPlugin.isAlive();
        AppWidgetManager manager = AppWidgetManager.getInstance(app);
        boolean hasLarge = manager != null && ids(app, manager, LargeWidgetProvider.class).length > 0;
        setTicking(app, playing && hasLarge);
        if (playing) renderProgress(app);
    }

    /** 桌面上有没有这个应用的小部件：一个都没有的话，封面不用下、状态不用每 5 秒写一遍 */
    static boolean anyPlaced(Context context) {
        Context app = context.getApplicationContext();
        AppWidgetManager manager = AppWidgetManager.getInstance(app);
        if (manager == null) return false;
        return ids(app, manager, SmallWidgetProvider.class).length + ids(app, manager, LargeWidgetProvider.class).length > 0;
    }

    static int[] ids(Context app, AppWidgetManager manager, Class<?> provider) {
        try {
            return manager.getAppWidgetIds(new ComponentName(app, provider));
        } catch (RuntimeException e) {
            // 系统服务没起来（开机过程中）
            return new int[0];
        }
    }

    /* ---------------------------------------------------------------- 排版 */

    private static RemoteViews views(
        Context app, AppWidgetManager manager, int id, boolean large,
        WidgetStore.State state, boolean playing, Bitmap cover
    ) {
        WidgetLayouts.Metrics m = metrics(app);
        List<WidgetLayouts.Cell> cells = large ? WidgetLayouts.large(m) : WidgetLayouts.small(m);
        if (SIZED) {
            Art art = art(app, state, cover, large, null);
            Map<SizeF, RemoteViews> map = new ArrayMap<>();
            for (WidgetLayouts.Cell cell : cells) {
                map.put(new SizeF(cell.w, cell.h), build(app, cell.variant, state, playing, art, m));
            }
            return sized(map);
        }
        int[] dp = sizeDp(app, manager, id, large);
        WidgetLayouts.Variant variant = WidgetLayouts.pick(cells, dp[0], dp[1]);
        return build(app, variant, state, playing, art(app, state, cover, large, dp), m);
    }

    @TargetApi(31)
    private static RemoteViews sized(Map<SizeF, RemoteViews> map) {
        return new RemoteViews(map);
    }

    /** 量布局用的尺寸（dp）。字号是按用户的字体大小换算过的，字放大了排法也跟着换 */
    static WidgetLayouts.Metrics metrics(Context app) {
        Resources r = app.getResources();
        float d = r.getDisplayMetrics().density;
        WidgetLayouts.Metrics m = new WidgetLayouts.Metrics();
        m.pad = r.getDimension(R.dimen.widget_padding) / d;
        m.padCompact = r.getDimension(R.dimen.widget_padding_compact) / d;
        m.gap = r.getDimension(R.dimen.widget_gap) / d;
        m.button = r.getDimension(R.dimen.widget_button) / d;
        m.buttonCompact = r.getDimension(R.dimen.widget_button_compact) / d;
        m.play = r.getDimension(R.dimen.widget_play) / d;
        m.playCompact = r.getDimension(R.dimen.widget_play_compact) / d;
        m.heart = r.getDimension(R.dimen.widget_heart) / d;
        m.title = r.getDimension(R.dimen.widget_title) / d;
        m.artist = r.getDimension(R.dimen.widget_artist) / d;
        m.time = r.getDimension(R.dimen.widget_time) / d;
        m.brand = r.getDimension(R.dimen.widget_brand) / d;
        m.progress = r.getDimension(R.dimen.widget_progress) / d;
        m.coverMax = r.getDimension(R.dimen.widget_cover_max) / d;
        m.coverMin = r.getDimension(R.dimen.widget_cover_min) / d;
        m.canResize = SIZED;
        return m;
    }

    private static int layoutFor(int kind) {
        switch (kind) {
            case WidgetLayouts.SMALL_SHORT: return R.layout.widget_small_short;
            case WidgetLayouts.SMALL_ROW: return R.layout.widget_small_wide;
            case WidgetLayouts.LARGE_FULL:
            case WidgetLayouts.LARGE_COMPACT: return R.layout.widget_large;
            default: return R.layout.widget_small;
        }
    }

    private static RemoteViews build(
        Context app, WidgetLayouts.Variant v, WidgetStore.State state, boolean playing, Art art, WidgetLayouts.Metrics m
    ) {
        boolean large = v.kind == WidgetLayouts.LARGE_FULL || v.kind == WidgetLayouts.LARGE_COMPACT;
        RemoteViews views = new RemoteViews(app.getPackageName(), layoutFor(v.kind));

        if (art.background != null) {
            views.setImageViewBitmap(R.id.widget_bg, art.background);
        } else {
            views.setImageViewResource(R.id.widget_bg, R.drawable.widget_glass_default);
        }
        int opacity = Math.max(0, Math.min(100, state.opacity));
        int alpha = Math.round(opacity * 2.55f);
        views.setInt(R.id.widget_bg, "setImageAlpha", alpha);
        views.setInt(R.id.widget_sheen, "setImageAlpha", alpha);
        views.setInt(R.id.widget_scrim, "setImageAlpha", Math.round(255 * FLOOR_SCRIM * (100 - opacity) / 100f));

        views.setTextViewText(R.id.widget_title, state.hasSong ? state.title : app.getString(R.string.widget_idle_title));
        views.setTextViewText(R.id.widget_artist, state.hasSong ? state.artist : app.getString(R.string.widget_idle_hint));

        views.setImageViewResource(R.id.widget_play, playing ? R.drawable.widget_ic_pause : R.drawable.widget_ic_play);
        views.setContentDescription(R.id.widget_play, app.getString(playing ? R.string.widget_pause : R.string.widget_play));
        views.setImageViewResource(R.id.widget_heart, state.starred ? R.drawable.widget_ic_heart_filled : R.drawable.widget_ic_heart);
        views.setContentDescription(R.id.widget_heart, app.getString(state.starred ? R.string.widget_unfavorite : R.string.widget_favorite));
        // 这首歌的音源不支持收藏：心还在原位，淡下去
        views.setInt(R.id.widget_heart, "setImageAlpha", state.canStar ? 255 : 90);
        if (opacity < HALO_BELOW_OPACITY) {
            for (int id : new int[] { R.id.widget_prev, R.id.widget_next, R.id.widget_heart }) {
                views.setInt(id, "setBackgroundResource", R.drawable.widget_press_halo);
            }
        }

        views.setOnClickPendingIntent(R.id.widget_play, action(app, ACTION_TOGGLE, playing));
        views.setOnClickPendingIntent(R.id.widget_next, action(app, ACTION_NEXT, playing));
        views.setOnClickPendingIntent(R.id.widget_prev, action(app, ACTION_PREVIOUS, playing));
        views.setOnClickPendingIntent(R.id.widget_heart, action(app, ACTION_FAVORITE, playing));
        views.setOnClickPendingIntent(R.id.widget_open, open(app));

        // 这种排法收起来的按钮（方块里连同它那一格一起收，剩下的按钮平分）。布局里没有的 id 桌面会跳过
        if (!v.prev) {
            views.setViewVisibility(R.id.widget_prev_box, View.GONE);
            views.setViewVisibility(R.id.widget_prev, View.GONE);
        }
        if (!v.next) {
            views.setViewVisibility(R.id.widget_next_box, View.GONE);
            views.setViewVisibility(R.id.widget_next, View.GONE);
        }
        if (!v.heart) views.setViewVisibility(R.id.widget_heart, View.GONE);
        if (v.compact && SIZED) compactButtons(app, views, m);

        if (large) {
            float density = app.getResources().getDisplayMetrics().density;
            if (v.cover <= 0) {
                views.setViewVisibility(R.id.widget_cover, View.GONE);
            } else {
                int cap = Math.round(v.cover * density);
                views.setInt(R.id.widget_cover, "setMaxWidth", cap);
                views.setInt(R.id.widget_cover, "setMaxHeight", cap);
                if (art.cover == null) {
                    views.setImageViewResource(R.id.widget_cover, R.drawable.widget_cover_placeholder);
                } else {
                    views.setImageViewBitmap(R.id.widget_cover, art.cover);
                }
            }
            if (v.kind == WidgetLayouts.LARGE_COMPACT) {
                views.setViewVisibility(R.id.widget_time_row, View.GONE);
                int pad = Math.round(m.padCompact * density);
                views.setViewPadding(R.id.widget_open, pad, pad, pad, pad);
            }
            applyProgress(views, state, playing);
        }
        return views;
    }

    /** 小一号的按钮（Android 12 起才能临时改 View 的大小） */
    @TargetApi(31)
    private static void compactButtons(Context app, RemoteViews views, WidgetLayouts.Metrics m) {
        Resources r = app.getResources();
        int buttonPad = r.getDimensionPixelSize(R.dimen.widget_button_pad_compact);
        int playPad = r.getDimensionPixelSize(R.dimen.widget_play_pad_compact);
        for (int id : new int[] { R.id.widget_prev, R.id.widget_next }) {
            views.setViewLayoutWidth(id, m.buttonCompact, TypedValue.COMPLEX_UNIT_DIP);
            views.setViewLayoutHeight(id, m.buttonCompact, TypedValue.COMPLEX_UNIT_DIP);
            views.setViewPadding(id, buttonPad, buttonPad, buttonPad, buttonPad);
        }
        views.setViewLayoutWidth(R.id.widget_play, m.playCompact, TypedValue.COMPLEX_UNIT_DIP);
        views.setViewLayoutHeight(R.id.widget_play, m.playCompact, TypedValue.COMPLEX_UNIT_DIP);
        views.setViewPadding(R.id.widget_play, playPad, playPad, playPad, playPad);
    }

    /**
     * 这个小部件现在多大（dp），老系统上挑排法用。桌面报的是一个范围：竖屏时宽取最小、高取最大，横屏反过来。
     * 有的桌面不报，按默认的格子大小估。
     */
    private static int[] sizeDp(Context app, AppWidgetManager manager, int id, boolean large) {
        Bundle options = manager.getAppWidgetOptions(id);
        boolean landscape = app.getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE;
        int w = 0;
        int h = 0;
        if (options != null) {
            w = options.getInt(landscape ? AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH : AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH);
            h = options.getInt(landscape ? AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT : AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT);
        }
        if (w <= 0) w = large ? 320 : 150;
        if (h <= 0) h = 150;
        return new int[] { w, h };
    }

    /* ---------------------------------------------------------------- 位图 */

    /** 一次重画用的两张位图：糊开的底、封面（没有封面时都是 null） */
    private static final class Art {
        Bitmap background;
        Bitmap cover;
    }

    /**
     * Android 12 起：糊图按小部件大致的长宽比画（桌面铺满时再裁，糊图怎么裁都一样），封面画成 widget_cover_max 那么大的正方形；
     * 两张都放进共享内存（asShared）：大号每秒整个重发一次，位图只传一个句柄，不用每次复制。
     * 老系统：按报的大小自己画圆角（dp 是报的大小）。
     */
    private static Art art(Context app, WidgetStore.State state, Bitmap cover, boolean large, int[] legacyDp) {
        Art art = new Art();
        if (cover == null) return art;
        float density = app.getResources().getDisplayMetrics().density;
        String key = state.coverFileKey;
        if (SIZED) {
            int w = large ? BACKDROP_SIDE : BACKDROP_SIDE * 3 / 4;
            int h = large ? BACKDROP_SIDE / 2 : BACKDROP_SIDE * 3 / 4;
            art.background = cached(backgrounds, key + "|" + w + "x" + h, () -> shared(GlassPainter.backdrop(cover, w, h)));
        } else {
            float longest = Math.max(legacyDp[0], legacyDp[1]);
            float side = Math.min(LEGACY_BACKGROUND_SIDE, longest * density);
            int w = Math.max(8, Math.round(side * legacyDp[0] / longest));
            int h = Math.max(8, Math.round(side * legacyDp[1] / longest));
            float radius = CORNER_DP * side / longest;
            art.background = cached(backgrounds, key + "|" + w + "x" + h, () -> GlassPainter.roundedBackdrop(cover, w, h, radius));
        }
        if (large) {
            int size = Math.min(COVER_SIDE_CAP, Math.round(app.getResources().getDimension(R.dimen.widget_cover_max)));
            art.cover = SIZED
                ? cached(covers, key + "|" + size, () -> shared(GlassPainter.squareCover(cover, size)))
                : cached(covers, key + "|r" + size, () -> GlassPainter.roundedCover(cover, size, COVER_CORNER_DP * density, density));
        }
        return art;
    }

    private interface Maker {
        Bitmap make();
    }

    private static Bitmap cached(LruCache<String, Bitmap> cache, String key, Maker maker) {
        Bitmap bitmap = cache.get(key);
        if (bitmap == null) {
            bitmap = maker.make();
            cache.put(key, bitmap);
        }
        return bitmap;
    }

    @TargetApi(31)
    private static Bitmap shared(Bitmap bitmap) {
        try {
            return bitmap.asShared();
        } catch (RuntimeException e) {
            // 共享内存不够：照常用普通位图，只是每次多复制一份
            return bitmap;
        }
    }

    private static void applyProgress(RemoteViews views, WidgetStore.State state, boolean playing) {
        long position = state.positionNow(playing);
        int progress = state.durationMs > 0 ? (int) Math.min(PROGRESS_MAX, position * PROGRESS_MAX / state.durationMs) : 0;
        views.setProgressBar(R.id.widget_progress, PROGRESS_MAX, progress, false);
        views.setTextViewText(R.id.widget_elapsed, state.hasSong ? WidgetStore.clock(position) : "");
        views.setTextViewText(R.id.widget_duration, state.hasSong && state.durationMs > 0 ? WidgetStore.clock(state.durationMs) : "");
    }

    /** 调试用：桌面怎么报小部件大小、系统给的圆角多大、按报的大小会挑哪种排法（设置里看不到，真机排查时用） */
    static String describe(Context context) {
        Context app = context.getApplicationContext();
        AppWidgetManager manager = AppWidgetManager.getInstance(app);
        StringBuilder out = new StringBuilder();
        float density = app.getResources().getDisplayMetrics().density;
        out.append("density=").append(density).append(" sized=").append(SIZED);
        if (Build.VERSION.SDK_INT >= 31) {
            out.append(" systemRadiusDp=").append(app.getResources().getDimension(android.R.dimen.system_app_widget_background_radius) / density);
        }
        if (manager == null) return out.toString();
        WidgetLayouts.Metrics m = metrics(app);
        for (Class<?> provider : new Class<?>[] { SmallWidgetProvider.class, LargeWidgetProvider.class }) {
            boolean large = provider == LargeWidgetProvider.class;
            List<WidgetLayouts.Cell> cells = large ? WidgetLayouts.large(m) : WidgetLayouts.small(m);
            out.append(" | ").append(provider.getSimpleName()).append(" cells=");
            for (WidgetLayouts.Cell cell : cells) out.append(Math.round(cell.w)).append('x').append(Math.round(cell.h)).append(',');
            for (int id : ids(app, manager, provider)) {
                int[] dp = sizeDp(app, manager, id, large);
                out.append(" #").append(id).append(' ').append(dp[0]).append('x').append(dp[1])
                    .append(" -> ").append(WidgetLayouts.pick(cells, dp[0], dp[1]));
            }
        }
        return out.toString();
    }

    /* ---------------------------------------------------------------- 进度条 */

    private static final Runnable tick = new Runnable() {
        @Override
        public void run() {
            Context app = tickContext;
            if (!ticking || app == null) return;
            renderProgress(app);
            if (ticking) main.postDelayed(this, 1000);
        }
    };

    private static void setTicking(Context app, boolean on) {
        tickContext = app;
        if (on == ticking) return;
        ticking = on;
        main.removeCallbacks(tick);
        if (on) main.postDelayed(tick, 1000);
    }

    /**
     * 进度条和已播时间每秒走一格。熄屏时不发。
     * - 老系统：只发这两样（部分更新），桌面把它并进上一次的完整内容；
     * - Android 12 起：交给桌面的是一整套排法，部分更新并不进去（系统只合并最外层，挑中的那一套收不到），
     *   只能整个重发。位图在共享内存里、点击意图是缓存的，重发的只是几十条文字和数字。
     */
    private static synchronized void renderProgress(Context app) {
        WidgetStore.State state = WidgetStore.read(app);
        boolean playing = state.playing && HomeWidgetPlugin.isAlive();
        if (!playing) {
            ticking = false;
            return;
        }
        PowerManager power = (PowerManager) app.getSystemService(Context.POWER_SERVICE);
        if (power != null && !power.isInteractive()) return;
        AppWidgetManager manager = AppWidgetManager.getInstance(app);
        int[] ids = manager == null ? new int[0] : ids(app, manager, LargeWidgetProvider.class);
        if (ids.length == 0) {
            ticking = false;
            return;
        }
        if (SIZED) {
            Bitmap cover = WidgetCovers.current(app, state.coverFileKey);
            for (int id : ids) manager.updateAppWidget(id, views(app, manager, id, true, state, true, cover));
            return;
        }
        RemoteViews views = new RemoteViews(app.getPackageName(), R.layout.widget_large);
        applyProgress(views, state, true);
        manager.partiallyUpdateAppWidget(ids, views);
    }

    /* ---------------------------------------------------------------- 点击 */

    private static int flags() {
        return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    }

    private static int code(String action) {
        switch (action) {
            case ACTION_TOGGLE: return 1;
            case ACTION_NEXT: return 2;
            case ACTION_PREVIOUS: return 3;
            default: return 4;
        }
    }

    /** 点击意图建一次就留着：大号每秒重发时不用每次都去系统那里要 */
    private static PendingIntent action(Context app, String action, boolean playing) {
        String key = action + (playing ? "|b" : "|a");
        synchronized (intents) {
            PendingIntent cached = intents.get(key);
            if (cached != null) return cached;
            PendingIntent intent;
            if (playing) {
                Intent broadcast = new Intent(app, WidgetActionReceiver.class).setAction(action);
                intent = PendingIntent.getBroadcast(app, code(action), broadcast, flags());
            } else {
                Intent activity = new Intent(app, WidgetActionActivity.class)
                    .setAction(action)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
                intent = PendingIntent.getActivity(app, 10 + code(action), activity, flags());
            }
            intents.put(key, intent);
            return intent;
        }
    }

    private static PendingIntent open(Context app) {
        synchronized (intents) {
            PendingIntent cached = intents.get("open");
            if (cached != null) return cached;
            PendingIntent intent = PendingIntent.getActivity(app, 20, launch(app), flags());
            intents.put("open", intent);
            return intent;
        }
    }

    /**
     * 打开应用（已经开着就回到前台）。直接点名主界面、用自己的 action，不借桌面图标的那个启动意图。
     * 要它起来后接着做的动作不放在这里，先交给 {@link HomeWidgetPlugin#setPending}（理由见那边）。
     */
    static Intent launch(Context app) {
        return new Intent(app, MainActivity.class)
            .setAction(ACTION_OPEN)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }
}
