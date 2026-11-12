package cn.baogutang.musicstreampro;

import android.app.UiModeManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.Configuration;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 告诉网页「这台是不是电视」（src/lib/tv.ts）。
 *
 * 系统的 UI 模式是电视，或者设备声明了 leanback（Android TV / Google TV 都有）就算；
 * 设备压根没有触摸屏也算（不少国产电视盒子既不报电视模式也不声明 leanback，但手机平板一定有触摸屏）。
 * 反过来「有触摸屏」不能说明不是电视：有的电视盒子会谎报触屏，所以只当作加分项。
 */
@CapacitorPlugin(name = "TvMode")
public class TvModePlugin extends Plugin {

    static boolean detect(Context context) {
        UiModeManager uiModeManager = (UiModeManager) context.getSystemService(Context.UI_MODE_SERVICE);
        if (uiModeManager != null && uiModeManager.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) {
            return true;
        }
        PackageManager pm = context.getPackageManager();
        return pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
            || !pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN);
    }

    @PluginMethod
    public void isTelevision(PluginCall call) {
        JSObject result = new JSObject();
        result.put("television", detect(getContext()));
        call.resolve(result);
    }
}
