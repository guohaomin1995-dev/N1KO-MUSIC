package cn.baogutang.musicstreampro.widget;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.os.Build;
import android.os.SystemClock;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

/**
 * 桌面小部件和网页那一侧播放器之间的桥（src/services/homeWidget.ts）。
 *
 * 网页 → 小部件：update 把「在放什么、放到哪、收藏了没」推过来，setStyle 推透明度；这里存下来、重画小部件。
 * 小部件 → 网页：按钮按下去变成一个 action 事件（toggle / next / previous / favorite，以及「没在放就放」的 play），播放器照做。
 * 事件带「留到有人听」：从小部件冷启动应用时，网页还没来得及挂监听，动作不会丢。
 * 桌面上加了（或删了）小部件时发 widgetsChanged：网页那一侧没有小部件时不推，加上以后要马上补一次（连封面）。
 *
 * 「打开应用后接着做」的动作只在进程内交接（{@link #setPending}），不放进 intent：
 * 主界面是对外开放的（桌面图标、深链接都要进），放在 intent 的 extra 里，别的应用就能伪造一个，
 * 替用户按播放、甚至按收藏（那会改到用户的流媒体账号）。中转页和广播接收器都不对外，只有它们能交这个动作。
 */
@CapacitorPlugin(name = "HomeWidget")
public class HomeWidgetPlugin extends Plugin {
    /** 交接的动作多久之内有效：应用没能起来（或者被别的事打断）的话，不能等用户下次自己打开时再突然执行 */
    private static final long PENDING_TTL_MS = 15_000;

    private static volatile HomeWidgetPlugin instance;
    private static String pendingAction;
    private static long pendingAt;
    /** 播放键（切换）一共交给播放器几次。中转页等「放起来没有」的时候看它：变了就是用户又按了一下 */
    private static volatile int toggleSeq;

    static int toggleSeq() {
        return toggleSeq;
    }

    /** 把应用打开到前台之前先交一个动作：主界面起来（冷启动）或回到前台（已经开着）时接着做 */
    static synchronized void setPending(String action) {
        pendingAction = action;
        pendingAt = SystemClock.elapsedRealtime();
    }

    private static synchronized String takePending() {
        String action = pendingAction;
        pendingAction = null;
        if (action == null) return null;
        return SystemClock.elapsedRealtime() - pendingAt <= PENDING_TTL_MS ? action : null;
    }

    /** 网页那一侧还在不在。不在了的话，存着的「正在放」是过期的 */
    static boolean isAlive() {
        return instance != null;
    }

    /** 把小部件上的一次按键交给播放器；应用不在了返回 false */
    static boolean dispatch(String action) {
        HomeWidgetPlugin plugin = instance;
        if (plugin == null) return false;
        String name = eventName(action);
        if (name == null) return false;
        JSObject data = new JSObject();
        data.put("action", name);
        if (WidgetRenderer.ACTION_FAVORITE.equals(action)) {
            /*
             * 收藏键说的是「变成和小部件上现在画的相反」，不是「切换一下」：从小部件冷启动应用时，
             * 网页那一侧还没查到这首收没收藏，按它当时以为的状态去切换，会把「取消收藏」做成又收藏一遍
             */
            data.put("starred", !WidgetStore.read(plugin.getContext()).starred);
        }
        if (WidgetRenderer.ACTION_TOGGLE.equals(action)) toggleSeq++;
        plugin.notifyListeners("action", data, true);
        return true;
    }

    /** 桌面上的小部件多了或少了（BaseWidgetProvider 叫）：告诉网页那一侧，加上了的话要马上补推一次 */
    static void widgetsChanged(Context context) {
        HomeWidgetPlugin plugin = instance;
        if (plugin == null) return;
        JSObject data = counts(context);
        plugin.notifyListeners("widgetsChanged", data, false);
    }

    private static JSObject counts(Context context) {
        Context app = context.getApplicationContext();
        AppWidgetManager manager = AppWidgetManager.getInstance(app);
        JSObject result = new JSObject();
        result.put("small", manager == null ? 0 : WidgetRenderer.ids(app, manager, SmallWidgetProvider.class).length);
        result.put("large", manager == null ? 0 : WidgetRenderer.ids(app, manager, LargeWidgetProvider.class).length);
        return result;
    }

    private static String eventName(String action) {
        if (action == null) return null;
        switch (action) {
            case WidgetRenderer.ACTION_TOGGLE: return "toggle";
            case WidgetRenderer.ACTION_NEXT: return "next";
            case WidgetRenderer.ACTION_PREVIOUS: return "previous";
            case WidgetRenderer.ACTION_FAVORITE: return "favorite";
            case WidgetRenderer.ACTION_PLAY: return "play";
            default: return null;
        }
    }

    @Override
    public void load() {
        instance = this;
        /*
         * 插件新建，就是网页刚起来：这时候一定还没在放。存着的「正在放」是上一个进程留下的（应用被更新、被杀掉时来不及改），
         * 不清掉的话，打开应用的头一两秒小部件会显示「暂停」、进度条自己往前走，直到网页推来真实状态
         */
        WidgetStore.State state = WidgetStore.read(getContext());
        if (state.playing) {
            state.playing = false;
            WidgetStore.write(getContext(), state);
        }
        // 冷启动：动作先发出去，带「留到有人听」，等网页挂上监听
        flushPending();
        // 应用刚起来：小部件上的按钮从「打开应用」换回「直接控制」之前，先按存着的状态画一遍
        WidgetRenderer.renderAll(getContext());
    }

    @Override
    protected void handleOnResume() {
        // 已经开着、被小部件叫回前台：到了前台再做（在后台开播会被系统拦，所以才叫回前台的）
        flushPending();
    }

    private void flushPending() {
        String action = takePending();
        if (action != null) dispatch(action);
    }

    @Override
    protected void handleOnDestroy() {
        /*
         * 界面没了，声音也就停了：小部件改回「没在放」，按钮改成打开应用。
         * 只在「没的就是当前这个」时才这么做：界面被系统重建时，新界面的 load 可能先于旧界面的销毁，
         * 旧的这一下不能把新的顶掉（那样应用明明在放，小部件却一直当它不在）。
         */
        if (instance != this) return;
        instance = null;
        Context context = getContext();
        WidgetStore.State state = WidgetStore.read(context);
        state.playing = false;
        WidgetStore.write(context, state);
        WidgetRenderer.renderAll(context);
    }

    @PluginMethod
    public void update(PluginCall call) {
        Context context = getContext();
        final Context app = context.getApplicationContext();
        JSONObject data = call.getData();
        WidgetStore.State before = WidgetStore.read(context);
        WidgetStore.State next = WidgetStore.read(context);
        next.hasSong = data.optBoolean("hasSong", false);
        next.title = data.optString("title", "");
        next.artist = data.optString("artist", "");
        next.playing = data.optBoolean("playing", false);
        next.starred = data.optBoolean("starred", false);
        next.canStar = data.optBoolean("canStar", false);
        next.positionMs = Math.max(0, Math.round(data.optDouble("position", 0) * 1000));
        next.positionAt = System.currentTimeMillis();
        next.durationMs = Math.max(0, Math.round(data.optDouble("duration", 0) * 1000));
        next.rate = WidgetStore.clampRate(data.optDouble("rate", 1));

        boolean looksDifferent = next.hasSong != before.hasSong
            || !next.title.equals(before.title)
            || !next.artist.equals(before.artist)
            || next.playing != before.playing
            || next.starred != before.starred
            || next.canStar != before.canStar
            || next.durationMs != before.durationMs
            // 暂停着拖了进度（或者按上一首回到了开头）：进度条不走，得重画才看得到
            || (!next.playing && Math.abs(next.positionMs - before.positionMs) >= 1000);

        JSObject result = new JSObject();
        if (!WidgetRenderer.anyPlaced(context)) {
            /*
             * 桌面上没有小部件（大多数人，以及电视）：只记下歌名这些便宜的，等以后加上小部件时先有个样子；
             * 封面不下、不换 key（加上小部件时网页那一侧会收到 widgetsChanged，再把封面发一遍），只是位置变了也不写。
             */
            if (looksDifferent) {
                next.coverKey = before.coverKey;
                WidgetStore.write(context, next);
            }
            result.put("coverAccepted", false);
            call.resolve(result);
            return;
        }

        /*
         * 封面：coverKey 说「现在该是哪一张」，每次都带；图本身（cover）只在换了的那一次带。
         * 存的是摘要（WidgetStore.coverKey）：地址里可能带着登录令牌。
         * key 变了却没带图（不该发生）：不认这个新 key，留着旧图，等带图的那一次再换。
         * 同一张又带了图、而手上那张不是它（上次没下下来，应用重开后网页那一侧又发了一遍）：也重新下。
         */
        String cover = data.optString("cover", "");
        String coverKey = WidgetStore.coverKey(data.optString("coverKey", ""));
        boolean coverChanged = (!coverKey.equals(before.coverKey) && (coverKey.isEmpty() || !cover.isEmpty()))
            || (!cover.isEmpty() && !coverKey.isEmpty() && !coverKey.equals(before.coverFileKey));
        next.coverKey = coverChanged ? coverKey : before.coverKey;
        WidgetStore.write(context, next);

        Runnable redraw = () -> WidgetRenderer.renderAll(app);
        if (coverChanged) {
            if (coverKey.isEmpty()) {
                WidgetCovers.clear(context);
            } else {
                WidgetCovers.load(app, cover, coverKey, redraw);
            }
        } else if (!coverKey.isEmpty() && coverKey.equals(before.coverKey) && !coverKey.equals(before.coverFileKey)) {
            // 这一张上次没下下来：到时候了就再试（WidgetCovers 管间隔和次数）
            WidgetCovers.retryIfDue(app, coverKey, redraw);
        }
        if (looksDifferent || (coverChanged && coverKey.isEmpty())) {
            WidgetRenderer.renderAll(context);
        } else {
            // 只是播放位置对了一下表：不重画，进度条接着走
            WidgetRenderer.syncTicker(context);
        }
        result.put("coverAccepted", true);
        call.resolve(result);
    }

    @PluginMethod
    public void setStyle(PluginCall call) {
        Context context = getContext();
        int opacity = call.getData().optInt("opacity", 85);
        if (WidgetStore.read(context).opacity != Math.max(0, Math.min(100, opacity))) {
            WidgetStore.setOpacity(context, opacity);
            WidgetRenderer.renderAll(context);
        }
        call.resolve();
    }

    /** 桌面上现在有几个、这台设备的桌面支不支持由应用发起「添加到桌面」 */
    @PluginMethod
    public void status(PluginCall call) {
        Context context = getContext();
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        JSObject result = counts(context);
        result.put("pinSupported", manager != null && Build.VERSION.SDK_INT >= 26 && pinSupported(manager));
        WidgetStore.State state = WidgetStore.read(context);
        result.put("debug", "alive=" + isAlive() + " self=" + (instance == this) + " playing=" + state.playing
            + " pos=" + state.positionNow(state.playing && isAlive()) + " " + WidgetRenderer.describe(context));
        call.resolve(result);
    }

    /** 请桌面弹出「添加小部件」的确认。桌面不支持时 requested 为 false，由网页提示手动去加 */
    @PluginMethod
    public void requestPin(PluginCall call) {
        Context context = getContext();
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        JSObject result = new JSObject();
        boolean requested = false;
        if (manager != null && Build.VERSION.SDK_INT >= 26 && pinSupported(manager)) {
            Class<?> provider = "large".equals(call.getString("size")) ? LargeWidgetProvider.class : SmallWidgetProvider.class;
            try {
                requested = requestPin(manager, new ComponentName(context, provider));
            } catch (Exception ignored) {
                // 有的桌面声称支持，真调又抛异常
            }
        }
        result.put("requested", requested);
        call.resolve(result);
    }

    @android.annotation.TargetApi(26)
    private static boolean pinSupported(AppWidgetManager manager) {
        return manager.isRequestPinAppWidgetSupported();
    }

    @android.annotation.TargetApi(26)
    private static boolean requestPin(AppWidgetManager manager, ComponentName provider) {
        return manager.requestPinAppWidget(provider, null, null);
    }
}
