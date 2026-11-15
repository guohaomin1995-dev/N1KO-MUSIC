package cn.baogutang.musicstreampro.widget;

import android.graphics.Bitmap;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Shader;

/**
 * 小部件毛玻璃底里「糊开的封面」那一层，和（老系统上用的）圆角封面，都是画好的位图。
 *
 * 安卓不让小部件模糊它身后的壁纸（窗口模糊只对应用自己的窗口有效，小部件是桌面替我们画的），
 * 所以这块玻璃是用当前封面做的：封面缩得很小、糊开、提一点饱和度，再放大铺满——颜色跟着歌走；
 * 上面压一层暗色保证白字看得清，压多深看封面有多亮（{@link #scrimAlpha}）。反光和描边是布局里的矢量图（drawable/widget_sheen），不在位图里：
 * 位图会被桌面缩放，画在里面的细线和颗粒会虚、会变粗（最早的版本就是这么糊的）。
 * 整块底的透明度由用户在设置里调（RemoteViews 里用 setImageAlpha），调低了壁纸就透出来。
 */
final class GlassPainter {
    /** 糊封面用的小图有多宽：越小越糊，放大后是一片柔和的色块 */
    private static final int BLUR_WIDTH = 64;
    private static final int BLUR_RADIUS = 4;
    private static final int BLUR_PASSES = 3;
    /**
     * 压在糊图上的暗色，按糊图的平均亮度定：压完以后的亮度不超过 {@link #TARGET_LUMINANCE}（白字对比度约 3.9:1，
     * 字还带阴影）。暗封面压得少（不少于 {@link #MIN_SCRIM}，和最早的固定值一样），白封面压得多（不超过 {@link #MAX_SCRIM}，
     * 再深就成黑板了）。
     */
    private static final double TARGET_LUMINANCE = 0.22;
    private static final double MIN_SCRIM = 0.25;
    private static final double MAX_SCRIM = 0.62;

    private GlassPainter() {}

    /**
     * 糊开的封面，一张没有圆角的图（Android 12 起用）：桌面把它铺满小部件，再按真实大小裁圆角。
     * 不用画得大——本来就是糊的，放大了还是一片平滑的颜色。
     */
    static Bitmap backdrop(Bitmap cover, int width, int height) {
        Bitmap out = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        Soft soft = soften(cover, width, height);
        paint.setShader(soft.shader);
        canvas.drawRect(0, 0, width, height, paint);
        canvas.drawColor(soft.scrim << 24);
        return out;
    }

    /**
     * 同一张糊图，但自己带圆角（Android 12 以前用：那时桌面不替小部件裁圆角）。
     * 圆角按桌面报的小部件大小算，报得不准时会有出入，老系统上只能如此。
     */
    static Bitmap roundedBackdrop(Bitmap cover, int width, int height, float radius) {
        Bitmap out = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        RectF rect = new RectF(0, 0, width, height);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        Soft soft = soften(cover, width, height);
        paint.setShader(soft.shader);
        canvas.drawRoundRect(rect, radius, radius, paint);
        paint.setShader(null);
        paint.setColor(soft.scrim << 24);
        canvas.drawRoundRect(rect, radius, radius, paint);
        return out;
    }

    /** 糊好的小图放大铺满 width×height 的着色器，和该压多深的暗色（0–255） */
    private static final class Soft {
        final Shader shader;
        final int scrim;

        Soft(Shader shader, int scrim) {
            this.shader = shader;
            this.scrim = scrim;
        }
    }

    private static Soft soften(Bitmap cover, int width, int height) {
        int bw = BLUR_WIDTH;
        int bh = Math.max(12, Math.round(BLUR_WIDTH * (float) height / width));
        int[] pixels = new int[bw * bh];
        Bitmap small = blurred(cover, bw, bh, pixels);
        BitmapShader shader = new BitmapShader(small, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
        Matrix matrix = new Matrix();
        matrix.setScale((float) width / bw, (float) height / bh);
        shader.setLocalMatrix(matrix);
        return new Soft(shader, scrimAlpha(pixels));
    }

    /** 糊图该压多深（0–255）：按平均亮度（相对亮度，线性空间）算，见 {@link #TARGET_LUMINANCE} */
    static int scrimAlpha(int[] pixels) {
        if (pixels.length == 0) return (int) Math.round(MIN_SCRIM * 255);
        double sum = 0;
        for (int p : pixels) sum += luminance(p);
        double mean = sum / pixels.length;
        double scrim = mean <= TARGET_LUMINANCE ? MIN_SCRIM : 1 - TARGET_LUMINANCE / mean;
        scrim = Math.max(MIN_SCRIM, Math.min(MAX_SCRIM, scrim));
        return (int) Math.round(scrim * 255);
    }

    /** sRGB 颜色的相对亮度（0 黑 – 1 白） */
    static double luminance(int color) {
        return 0.2126 * linear((color >> 16) & 0xFF) + 0.7152 * linear((color >> 8) & 0xFF) + 0.0722 * linear(color & 0xFF);
    }

    private static double linear(int channel) {
        double c = channel / 255.0;
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    /** 封面居中裁成正方形、缩放到 size×size（Android 12 起用：圆角和描边由布局里的 ImageView 管） */
    static Bitmap squareCover(Bitmap cover, int size) {
        Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        int side = Math.min(cover.getWidth(), cover.getHeight());
        int left = (cover.getWidth() - side) / 2;
        int top = (cover.getHeight() - side) / 2;
        canvas.drawBitmap(cover, new Rect(left, top, left + side, top + side), new RectF(0, 0, size, size), paint);
        return out;
    }

    /** 圆角封面：居中裁成正方形，外面一圈很淡的描边，和玻璃底分开 */
    static Bitmap roundedCover(Bitmap cover, int size, float radius, float density) {
        Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        BitmapShader shader = new BitmapShader(cover, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
        float scale = (float) size / Math.min(cover.getWidth(), cover.getHeight());
        Matrix matrix = new Matrix();
        matrix.setScale(scale, scale);
        matrix.postTranslate((size - cover.getWidth() * scale) / 2f, (size - cover.getHeight() * scale) / 2f);
        shader.setLocalMatrix(matrix);
        paint.setShader(shader);
        RectF rect = new RectF(0, 0, size, size);
        canvas.drawRoundRect(rect, radius, radius, paint);

        Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        stroke.setStyle(Paint.Style.STROKE);
        float strokeWidth = Math.max(1f, density * 0.75f);
        stroke.setStrokeWidth(strokeWidth);
        stroke.setColor(0x2EFFFFFF);
        float inset = strokeWidth / 2f;
        canvas.drawRoundRect(new RectF(inset, inset, size - inset, size - inset), radius - inset, radius - inset, stroke);
        return out;
    }

    /** 封面居中裁到 w×h 的小图上，提一点饱和度，再糊开；糊好的像素也留在 pixels 里（算亮度用） */
    private static Bitmap blurred(Bitmap cover, int w, int h, int[] pixels) {
        Bitmap small = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(small);
        Paint paint = new Paint(Paint.FILTER_BITMAP_FLAG | Paint.ANTI_ALIAS_FLAG);
        ColorMatrix saturation = new ColorMatrix();
        // 糊开以后颜色会互相冲淡、发灰，先把饱和度提上去
        saturation.setSaturation(1.8f);
        paint.setColorFilter(new ColorMatrixColorFilter(saturation));
        float scale = Math.max((float) w / cover.getWidth(), (float) h / cover.getHeight());
        float dw = cover.getWidth() * scale;
        float dh = cover.getHeight() * scale;
        RectF dst = new RectF((w - dw) / 2f, (h - dh) / 2f, (w + dw) / 2f, (h + dh) / 2f);
        // 按「铺满」缩放（取大的那个比例），小图上不会留透明的边
        canvas.drawBitmap(cover, new Rect(0, 0, cover.getWidth(), cover.getHeight()), dst, paint);

        small.getPixels(pixels, 0, w, 0, 0, w, h);
        for (int i = 0; i < BLUR_PASSES; i++) boxBlur(pixels, w, h, BLUR_RADIUS);
        small.setPixels(pixels, 0, w, 0, 0, w, h);
        return small;
    }

    /** 一遍方框模糊（横一遍、竖一遍，边上按最外一个像素延伸）；连做三遍就很接近高斯模糊 */
    static void boxBlur(int[] pixels, int w, int h, int radius) {
        int[] line = new int[Math.max(w, h)];
        int window = radius * 2 + 1;
        for (int y = 0; y < h; y++) {
            int row = y * w;
            int r = 0;
            int g = 0;
            int b = 0;
            for (int i = -radius; i <= radius; i++) {
                int p = pixels[row + clamp(i, 0, w - 1)];
                r += (p >> 16) & 0xFF;
                g += (p >> 8) & 0xFF;
                b += p & 0xFF;
            }
            for (int x = 0; x < w; x++) {
                line[x] = 0xFF000000 | ((r / window) << 16) | ((g / window) << 8) | (b / window);
                int out = pixels[row + clamp(x - radius, 0, w - 1)];
                int in = pixels[row + clamp(x + radius + 1, 0, w - 1)];
                r += ((in >> 16) & 0xFF) - ((out >> 16) & 0xFF);
                g += ((in >> 8) & 0xFF) - ((out >> 8) & 0xFF);
                b += (in & 0xFF) - (out & 0xFF);
            }
            System.arraycopy(line, 0, pixels, row, w);
        }
        for (int x = 0; x < w; x++) {
            int r = 0;
            int g = 0;
            int b = 0;
            for (int i = -radius; i <= radius; i++) {
                int p = pixels[clamp(i, 0, h - 1) * w + x];
                r += (p >> 16) & 0xFF;
                g += (p >> 8) & 0xFF;
                b += p & 0xFF;
            }
            for (int y = 0; y < h; y++) {
                line[y] = 0xFF000000 | ((r / window) << 16) | ((g / window) << 8) | (b / window);
                int out = pixels[clamp(y - radius, 0, h - 1) * w + x];
                int in = pixels[clamp(y + radius + 1, 0, h - 1) * w + x];
                r += ((in >> 16) & 0xFF) - ((out >> 16) & 0xFF);
                g += ((in >> 8) & 0xFF) - ((out >> 8) & 0xFF);
                b += (in & 0xFF) - (out & 0xFF);
            }
            for (int y = 0; y < h; y++) pixels[y * w + x] = line[y];
        }
    }

    private static int clamp(int v, int lo, int hi) {
        return v < lo ? lo : Math.min(v, hi);
    }
}
