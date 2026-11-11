package cn.baogutang.musicstreampro;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.io.OutputStream;

/**
 * 把一张图存进系统相册（Pictures/X-MUSIC）。
 *
 * 给「只有一部手机」的扫码登录用：二维码存进相册，再在网易云 / QQ / 微信的扫一扫里
 * 从相册选这张图。Android 10 起往 MediaStore 写自己的图片不需要任何存储权限；
 * 更老的系统要 WRITE_EXTERNAL_STORAGE，这里不申请，直接回 UNSUPPORTED，界面改提示截图。
 */
@CapacitorPlugin(name = "Gallery")
public class GalleryPlugin extends Plugin {

    @PluginMethod
    public void saveImage(PluginCall call) {
        String data = call.getString("data");
        if (data == null || data.isEmpty()) {
            call.reject("没有图片数据", "BAD_INPUT");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("系统版本太低，不能直接存进相册", "UNSUPPORTED");
            return;
        }

        String mime = "image/png";
        if (data.startsWith("data:")) {
            int semi = data.indexOf(';');
            if (semi > 5) mime = data.substring(5, semi);
            int comma = data.indexOf(',');
            data = comma >= 0 ? data.substring(comma + 1) : data;
        }
        if (!mime.startsWith("image/")) {
            call.reject("不是图片", "BAD_INPUT");
            return;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("图片数据损坏", "BAD_INPUT");
            return;
        }

        String ext = "image/jpeg".equals(mime) ? ".jpg" : ".png";
        String name = call.getString("name", "X-MUSIC-" + System.currentTimeMillis());
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, name + ext);
        values.put(MediaStore.Images.Media.MIME_TYPE, mime);
        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/X-MUSIC");
        values.put(MediaStore.Images.Media.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            call.reject("相册写入失败", "WRITE_FAILED");
            return;
        }
        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) throw new IOException("no output stream");
            out.write(bytes);
        } catch (IOException e) {
            resolver.delete(uri, null, null);
            call.reject("相册写入失败", "WRITE_FAILED");
            return;
        }
        values.clear();
        values.put(MediaStore.Images.Media.IS_PENDING, 0);
        resolver.update(uri, values, null, null);
        call.resolve();
    }
}
