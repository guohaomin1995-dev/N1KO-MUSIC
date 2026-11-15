package cn.baogutang.musicstreampro.widget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.os.Bundle;

/**
 * 两种小部件共用：桌面要求刷新、小部件被拉大拉小、加了新的一个，都整套重画。
 * 加了或删了小部件还要告诉网页那一侧（应用开着的话）：没有小部件时它不推状态，加上以后要马上补一次。
 */
abstract class BaseWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        WidgetRenderer.renderAll(context);
        HomeWidgetPlugin.widgetsChanged(context);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int id, Bundle options) {
        WidgetRenderer.renderAll(context);
    }

    @Override
    public void onDeleted(Context context, int[] ids) {
        WidgetRenderer.renderAll(context);
        HomeWidgetPlugin.widgetsChanged(context);
    }
}
