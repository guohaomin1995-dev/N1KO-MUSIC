package cn.baogutang.musicstreampro.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** 小部件里不碰安卓界面的那几处计算：糊封面用的方框模糊和压暗、播放位置的推算、封面 key。 */
public class WidgetMathTest {

    private static int gray(int v) {
        return 0xFF000000 | (v << 16) | (v << 8) | v;
    }

    @Test
    public void blurKeepsAFlatImageFlat() {
        int w = 16;
        int h = 9;
        int[] pixels = new int[w * h];
        java.util.Arrays.fill(pixels, gray(120));
        GlassPainter.boxBlur(pixels, w, h, 5);
        for (int p : pixels) assertEquals(gray(120), p);
    }

    @Test
    public void blurSpreadsABrightDotAndKeepsItsWeight() {
        int w = 21;
        int h = 21;
        int[] pixels = new int[w * h];
        java.util.Arrays.fill(pixels, gray(0));
        pixels[10 * w + 10] = gray(242);
        GlassPainter.boxBlur(pixels, w, h, 5);
        // 一个亮点摊成 11×11 的一块：每个像素 242 / 121 = 2，外面还是黑的
        int sum = 0;
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int v = pixels[y * w + x] & 0xFF;
                boolean inside = Math.abs(x - 10) <= 5 && Math.abs(y - 10) <= 5;
                assertEquals(inside ? 2 : 0, v);
                sum += v;
            }
        }
        assertEquals(242, sum);
    }

    @Test
    public void blurClampsAtTheEdgesInsteadOfDarkening() {
        // 左半白右半黑：糊完以后最左一列还是纯白（边上按最外一个像素延伸，不会被「画外的黑」拉暗）
        int w = 24;
        int h = 4;
        int[] pixels = new int[w * h];
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) pixels[y * w + x] = gray(x < 12 ? 255 : 0);
        GlassPainter.boxBlur(pixels, w, h, 3);
        assertEquals(255, pixels[0] & 0xFF);
        assertEquals(0, pixels[w - 1] & 0xFF);
        int middle = pixels[12] & 0xFF;
        assertTrue("过渡带在中间", middle > 60 && middle < 200);
    }

    @Test
    public void positionAdvancesOnlyWhilePlayingAndStopsAtTheEnd() {
        WidgetStore.State state = new WidgetStore.State();
        state.positionMs = 10_000;
        state.durationMs = 200_000;
        state.positionAt = System.currentTimeMillis() - 4_000;
        assertEquals(10_000, state.positionNow(false));
        long now = state.positionNow(true);
        assertTrue("往后推了大约 4 秒", now >= 14_000 && now < 15_000);

        // 快放完了：不超过总时长
        state.positionMs = 195_000;
        state.positionAt = System.currentTimeMillis() - 8_000;
        assertEquals(200_000, state.positionNow(true));
    }

    @Test
    public void positionStopsAdvancingWhenThePlayerStopsReporting() {
        // 网页那一侧很久没来对表（卡住了、被系统冻住了）：最多往后推 12 秒，不会一路走到曲终
        WidgetStore.State state = new WidgetStore.State();
        state.positionMs = 10_000;
        state.durationMs = 200_000;
        state.positionAt = System.currentTimeMillis() - 500_000;
        assertEquals(10_000 + WidgetStore.MAX_EXTRAPOLATE_MS, state.positionNow(true));
    }

    @Test
    public void positionAdvancesAtThePlaybackRate() {
        // 2 倍速：过了 4 秒，进度走 8 秒（以前按 1 倍推，每 5 秒对表时往前跳一大截）
        WidgetStore.State state = new WidgetStore.State();
        state.positionMs = 10_000;
        state.durationMs = 200_000;
        state.rate = 2f;
        state.positionAt = System.currentTimeMillis() - 4_000;
        long now = state.positionNow(true);
        assertTrue("往后推了大约 8 秒", now >= 18_000 && now < 20_000);
    }

    @Test
    public void rateIsClampedToSaneValues() {
        assertEquals(1f, WidgetStore.clampRate(0), 0);
        assertEquals(1f, WidgetStore.clampRate(-2), 0);
        assertEquals(1f, WidgetStore.clampRate(Double.NaN), 0);
        assertEquals(1f, WidgetStore.clampRate(Double.POSITIVE_INFINITY), 0);
        assertEquals(0.25f, WidgetStore.clampRate(0.1), 0);
        assertEquals(4f, WidgetStore.clampRate(9), 0);
        assertEquals(1.5f, WidgetStore.clampRate(1.5), 0);
    }

    @Test
    public void coverKeyIsADigestNotTheAddress() {
        // Jellyfin 的封面地址带着登录令牌：存下来的只能是摘要
        String url = "http://nas.local:8096/Items/1/Images/Primary?api_key=SECRET_TOKEN";
        String key = WidgetStore.coverKey(url);
        assertEquals(64, key.length());
        assertTrue(key.matches("[0-9a-f]{64}"));
        assertFalse(key.contains("SECRET"));
        assertEquals("同一个地址，同一个 key", key, WidgetStore.coverKey(url));
        assertNotEquals(key, WidgetStore.coverKey(url + "x"));
        assertEquals("没有封面还是空串", "", WidgetStore.coverKey(""));
        assertEquals("", WidgetStore.coverKey(null));
    }

    @Test
    public void scrimDarkensBrightCoversMore() {
        int[] white = new int[64];
        int[] black = new int[64];
        int[] gray = new int[64];
        java.util.Arrays.fill(white, gray(255));
        java.util.Arrays.fill(black, gray(0));
        java.util.Arrays.fill(gray, gray(180));
        int onWhite = GlassPainter.scrimAlpha(white);
        int onBlack = GlassPainter.scrimAlpha(black);
        int onGray = GlassPainter.scrimAlpha(gray);
        assertEquals("暗封面和以前一样压 25%", 64, onBlack);
        assertEquals("白封面压到上限 62%", 158, onWhite);
        assertTrue(onGray > onBlack && onGray < onWhite);
        // 压完以后的亮度：浅灰封面上白字的对比度至少 3.5:1（字还有阴影）
        double after = GlassPainter.luminance(gray(180)) * (1 - onGray / 255.0);
        assertTrue("对比度 " + (1.05 / (after + 0.05)), 1.05 / (after + 0.05) >= 3.5);
    }

    @Test
    public void clockFormatsMinutesAndHours() {
        assertEquals("0:00", WidgetStore.clock(0));
        assertEquals("1:23", WidgetStore.clock(83_400));
        assertEquals("59:59", WidgetStore.clock(3_599_000));
        assertEquals("1:02:03", WidgetStore.clock(3_723_000));
        assertEquals("0:00", WidgetStore.clock(-5));
    }
}
