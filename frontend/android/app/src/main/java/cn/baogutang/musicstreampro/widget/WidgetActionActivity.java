package cn.baogutang.musicstreampro.widget;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.WindowManager;

/**
 * 没在放的时候，小部件上的按钮打开的是这个看不见的中转页：全透明、不接触摸（桌面照常能点）、没有动画。
 *
 * 为什么不直接发广播：
 * - 暂停以后应用随时可能被系统收走。广播倒是送得到（系统会把进程重新拉起来），可网页播放器要整个界面起来才有，
 *   从广播里打开界面又看系统脸色（Android 14 起桌面点的广播给 10 秒的放行，小米这类系统还另有一层「后台弹出界面」的开关）。
 *   由用户点击直接打开的页面一定起得来：应用不在了（或者还没有可以放的歌）就把应用打开，让它起来后接着做。
 * - 应用还在后台时，播放器是网页，要它「在后台从暂停变成播放」并不总是成功：Android 15 起，没有可见界面、
 *   也没有前台服务的应用拿不到音频焦点，刚开播就会被停掉（Android 17 更是直接静音）；真机上就是应用刚启动、还没放过歌就退到后台时。
 *   这个页面在的这一小会儿，应用算「在前台」，播放器能把声音放起来、把前台服务拉起来；
 *   确认真的在放了就关掉自己，桌面上什么都不会动。几秒钟还是没放起来，就把应用打开到前台再放——总之按了一定有反应。
 * - 这个页面在的时候桌面没有按键焦点（遥控器、键盘的按键会等它走），所以最多留几秒。
 */
public class WidgetActionActivity extends Activity {
    /** 最多等多久；过了还没放起来就把应用打开到前台 */
    private static final long WAIT_MS = 3500;
    /**
     * 「在放」持续这么久就算放起来了，可以走。不能久留：这个页面在的时候，荣耀桌面不接收点击
     * （系统把开这个页面当成从桌面切走），紧跟着点下一首会被吞掉。
     * 也不能一看到「在放」就走：通知栏的前台服务是播放器在同一刻叫起来的，要应用还在前台时才起得来，留一点余量。
     */
    private static final long STABLE_MS = 300;
    private static final long POLL_MS = 150;
    /** 这么短的时间里连按两下播放键算手抖，当一次 */
    private static final long DOUBLE_TAP_MS = 600;
    /**
     * 暂停着按上一首 / 下一首：这么久之后歌没换、也没放起来，说明这一下本来就不开播
     * （已经是最后一首，或者上一首只是回到这首开头），不用再等、更不能替用户开播
     */
    private static final long SKIP_SETTLE_MS = 1000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean waiting;
    private long startedAt;
    private long playingSince;
    /** 等的这一会儿里放起来过 */
    private boolean everPlayed;
    /** 开始等的那一刻，播放键一共被交出去过几次（见 HomeWidgetPlugin#toggleSeq） */
    private int toggleSeqAtStart;
    /** 是按上一首 / 下一首开始等的；这时记着按之前是哪首歌 */
    private boolean skip;
    private String songBefore = "";

    private final Runnable check = new Runnable() {
        @Override
        public void run() {
            long now = SystemClock.uptimeMillis();
            if (HomeWidgetPlugin.toggleSeq() != toggleSeqAtStart) {
                // 等的这一会儿用户按了暂停（放起来以后小部件上那颗键走的是广播，不经过这里）：听他的，不替他做主
                finish();
                return;
            }
            WidgetStore.State state = WidgetStore.read(WidgetActionActivity.this);
            boolean playing = state.playing && HomeWidgetPlugin.isAlive();
            if (playing) {
                everPlayed = true;
                if (playingSince == 0) playingSince = now;
                if (now - playingSince >= STABLE_MS) {
                    finish();
                    return;
                }
            } else {
                playingSince = 0;
            }
            boolean songChanged = skip && !songBefore.equals(songOf(state));
            if (skip && !everPlayed && !songChanged && now - startedAt >= SKIP_SETTLE_MS) {
                finish();
                return;
            }
            if (now - startedAt >= WAIT_MS) {
                // 后台放不起来：到前台去放（ACTION_PLAY 是「没在放就放」，不会把已经放起来的又按停）
                open(WidgetRenderer.ACTION_PLAY);
                return;
            }
            handler.postDelayed(this, POLL_MS);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 全透明（alpha 为 0 的窗口，系统才允许触摸穿过它落到桌面上）、不接触摸、不抢焦点
        WindowManager.LayoutParams params = getWindow().getAttributes();
        params.alpha = 0f;
        params.dimAmount = 0f;
        getWindow().setAttributes(params);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
            | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
            | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL);
        if (savedInstanceState != null) {
            /*
             * 被系统重建（清单里已经声明自己处理配置变化，正常不会走到这里）：动作上一个已经交出去了，
             * 不能再发一遍；还在等的话接着等，不然直接走
             */
            if (savedInstanceState.getBoolean("waiting")) {
                waiting = true;
                startedAt = savedInstanceState.getLong("startedAt");
                everPlayed = savedInstanceState.getBoolean("everPlayed");
                toggleSeqAtStart = savedInstanceState.getInt("toggleSeqAtStart");
                skip = savedInstanceState.getBoolean("skip");
                songBefore = savedInstanceState.getString("songBefore", "");
                handler.postDelayed(check, POLL_MS);
            } else {
                finish();
            }
            return;
        }
        handle(getIntent());
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putBoolean("waiting", waiting);
        out.putLong("startedAt", startedAt);
        out.putBoolean("everPlayed", everPlayed);
        out.putInt("toggleSeqAtStart", toggleSeqAtStart);
        out.putBoolean("skip", skip);
        out.putString("songBefore", songBefore);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // 还在等上一次的结果时又按了一个键
        handle(intent);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(check);
        super.onDestroy();
    }

    private void handle(Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (action == null) {
            if (!waiting) finish();
            return;
        }
        boolean toggle = WidgetRenderer.ACTION_TOGGLE.equals(action);
        /*
         * 走到这里的播放键，小部件上画的一定是「播放」（在放的时候那颗键走广播）：按的意思是「放」，
         * 交出去的是 PLAY 而不是切换。前一下还没放起来时再按一下，不会反倒把它按停；
         * 也不算「用户又按了播放键」（toggleSeq 不变），不会打断这边的等待。
         */
        String sent = toggle ? WidgetRenderer.ACTION_PLAY : action;
        WidgetStore.State state = WidgetStore.read(this);
        if (!state.hasSong || !HomeWidgetPlugin.isAlive()) {
            open(sent);
            return;
        }
        long now = SystemClock.uptimeMillis();
        // 还在等上一下「播放」的结果，紧跟着又是一下：手抖连按，当一次
        if (toggle && waiting && now - startedAt < DOUBLE_TAP_MS) return;
        boolean skipping = WidgetRenderer.ACTION_NEXT.equals(action) || WidgetRenderer.ACTION_PREVIOUS.equals(action);
        if (!waiting && !state.playing && (toggle || skipping)) {
            /*
             * 从暂停按播放、或者暂停着切歌（播放器切歌会顺带开播）：都是在后台开播，等它真的放起来。
             * 切歌要记下按之前是哪首，好分辨「这一下本来就不开播」（见 SKIP_SETTLE_MS）
             */
            waiting = true;
            startedAt = now;
            playingSince = 0;
            everPlayed = false;
            skip = skipping;
            songBefore = songOf(state);
            toggleSeqAtStart = HomeWidgetPlugin.toggleSeq();
            HomeWidgetPlugin.dispatch(sent);
            handler.postDelayed(check, POLL_MS);
            return;
        }
        HomeWidgetPlugin.dispatch(sent);
        // 收藏交出去就完事；正在等播放结果的话接着等（check 会发现期间按过暂停而收手）
        if (!waiting) finish();
    }

    private static String songOf(WidgetStore.State state) {
        return state.title + "\n" + state.artist + "\n" + state.coverKey;
    }

    private void open(String action) {
        handler.removeCallbacks(check);
        waiting = false;
        try {
            HomeWidgetPlugin.setPending(action);
            startActivity(WidgetRenderer.launch(this));
        } catch (Exception ignored) {
            // 打不开就算了，不能让中转页崩掉
        }
        finish();
    }

    @Override
    public void finish() {
        super.finish();
        overridePendingTransition(0, 0);
    }
}
