package cn.baogutang.musicstreampro.widget;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 正在放的时候小部件上的按钮：发一条广播到这里，转给网页那一侧的播放器。桌面上什么都不会动。
 */
public class WidgetActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;
        if (HomeWidgetPlugin.dispatch(action)) return;
        /*
         * 应用不在了（被系统直接杀掉，来不及把小部件改回「没在放」），小部件上显示的还是「正在放」。
         * 先把小部件改回真实的样子，之后的按钮都走中转页，一定打得开应用。
         */
        WidgetStore.State state = WidgetStore.read(context);
        state.playing = false;
        WidgetStore.write(context, state);
        WidgetRenderer.renderAll(context);
        // 这时候的播放键画的是「暂停」：用户想停，而声音其实早就没了——改回真实的样子就是他要的结果，不能反过来把应用打开开播
        if (WidgetRenderer.ACTION_TOGGLE.equals(action)) return;
        /*
         * 切歌、收藏要应用在才做得了：试着打开。桌面点出来的广播，Android 14 起有 10 秒可以打开界面，
         * 但小米这类系统还有自己的「后台弹出界面」开关（默认关）；打不开的话再点一次，那时按钮走的是中转页
         */
        try {
            HomeWidgetPlugin.setPending(action);
            context.startActivity(WidgetRenderer.launch(context));
        } catch (Exception ignored) {
            // 系统不让从后台打开界面
        }
    }
}
