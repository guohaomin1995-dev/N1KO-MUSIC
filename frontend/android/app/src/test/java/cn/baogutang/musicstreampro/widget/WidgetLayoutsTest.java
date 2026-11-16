package cn.baogutang.musicstreampro.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.junit.Test;

/** 各种大小下挑哪种排法（WidgetLayouts）：数值和 values / values-sw600dp 的 widget_dimens 一致，字体大小按 1 倍 */
public class WidgetLayoutsTest {

    private static WidgetLayouts.Metrics phone(boolean canResize) {
        WidgetLayouts.Metrics m = new WidgetLayouts.Metrics();
        m.pad = 14;
        m.padCompact = 10;
        m.gap = 14;
        m.button = 44;
        m.buttonCompact = 36;
        m.play = 46;
        m.playCompact = 38;
        m.heart = 36;
        m.title = 16;
        m.artist = 12;
        m.time = 10;
        m.brand = 10;
        m.progress = 3;
        m.coverMax = 168;
        m.coverMin = 64;
        m.canResize = canResize;
        return m;
    }

    private static WidgetLayouts.Metrics tablet() {
        WidgetLayouts.Metrics m = new WidgetLayouts.Metrics();
        m.pad = 18;
        m.padCompact = 12;
        m.gap = 18;
        m.button = 56;
        m.buttonCompact = 44;
        m.play = 60;
        m.playCompact = 48;
        m.heart = 46;
        m.title = 21;
        m.artist = 15;
        m.time = 12;
        m.brand = 12;
        m.progress = 4;
        m.coverMax = 240;
        m.coverMin = 80;
        m.canResize = true;
        return m;
    }

    /** 右边那一栏实际多宽 */
    private static float controlsWidth(WidgetLayouts.Metrics m, WidgetLayouts.Variant v, float w) {
        float pad = v.kind == WidgetLayouts.LARGE_FULL ? m.pad : m.padCompact;
        float cover = v.cover > 0 ? v.cover + m.gap : 0;
        return w - 2 * pad - cover;
    }

    private static float playOf(WidgetLayouts.Metrics m, WidgetLayouts.Variant v) {
        return v.compact ? m.playCompact : m.play;
    }

    @Test
    public void cellsFitTheLauncherLimitAndFormAFullGrid() {
        for (WidgetLayouts.Metrics m : new WidgetLayouts.Metrics[] { phone(true), phone(false), tablet() }) {
            for (List<WidgetLayouts.Cell> cells : java.util.Arrays.asList(WidgetLayouts.small(m), WidgetLayouts.large(m))) {
                assertTrue("最多 16 种", cells.size() <= WidgetLayouts.MAX_CELLS);
                Set<Float> ws = new HashSet<>();
                Set<Float> hs = new HashSet<>();
                Set<String> keys = new HashSet<>();
                for (WidgetLayouts.Cell c : cells) {
                    ws.add(c.w);
                    hs.add(c.h);
                    assertTrue("没有重复的格子", keys.add(c.w + "x" + c.h));
                }
                // 每个宽度都配了每个高度：桌面挑中的一定是「宽、高各取不超过实际的最大一档」
                assertEquals(ws.size() * hs.size(), cells.size());
            }
        }
    }

    @Test
    public void largeNeverStarvesTheButtonsOfRoom() {
        for (WidgetLayouts.Metrics m : new WidgetLayouts.Metrics[] { phone(true), phone(false), tablet() }) {
            List<WidgetLayouts.Cell> cells = WidgetLayouts.large(m);
            for (int w = 250; w <= 700; w += 3) {
                for (int h = 110; h <= 320; h += 7) {
                    WidgetLayouts.Variant v = WidgetLayouts.pick(cells, w, h);
                    if (v.cover <= 0 || v.kind == WidgetLayouts.LARGE_ROW) continue;
                    assertTrue("封面不超过上限", v.cover <= m.coverMax);
                    assertTrue("封面不小于下限", v.cover >= m.coverMin);
                    assertTrue(w + "x" + h + " " + v + " 三个按钮放得下",
                        controlsWidth(m, v, w) >= 3 * playOf(m, v));
                }
            }
        }
    }

    @Test
    public void largeOnACommonPhoneGridShrinksTheCoverInsteadOfClippingButtons() {
        // 手机 5 列的 4×2：大约 300×180dp。以前封面按高度长到 152dp，右边只剩 106dp，三个按钮被切
        WidgetLayouts.Metrics m = phone(true);
        WidgetLayouts.Variant v = WidgetLayouts.pick(WidgetLayouts.large(m), 300, 180);
        assertEquals(WidgetLayouts.LARGE_FULL, v.kind);
        assertTrue("还有封面", v.cover >= m.coverMin);
        assertTrue("右边至少 3 个播放键宽", controlsWidth(m, v, 300) >= 3 * m.play);
    }

    @Test
    public void largeOnTheHonorTabletKeepsTheFullCover() {
        // 荣耀平板上 4×2 实际 556×232dp：和以前一样，封面按高度 196dp（上限 240），排法是完整的
        WidgetLayouts.Variant v = WidgetLayouts.pick(WidgetLayouts.large(tablet()), 556, 232);
        assertEquals(WidgetLayouts.LARGE_FULL, v.kind);
        assertEquals(240f, v.cover, 0.01f);
        assertFalse(v.compact);
    }

    @Test
    public void largeAtItsSmallestUsesTheCompactLayout() {
        // 允许的最小尺寸 250×110：去掉时间行、按钮小一号；封面按小一号的按钮和留白算还放得下
        WidgetLayouts.Variant v = WidgetLayouts.pick(WidgetLayouts.large(phone(true)), 250, 110);
        assertEquals(WidgetLayouts.LARGE_COMPACT, v.kind);
        assertTrue("小一号的按钮", v.compact);
        float room = 250 - 2 * 10 - 14 - (3 * 38 + 6);
        assertEquals(Math.min(168, room), v.cover, 0.01f);

        // 再窄（桌面不按 minResizeWidth 来的时候）：不放封面
        assertEquals(0f, WidgetLayouts.pick(WidgetLayouts.large(phone(true)), 200, 110).cover, 0.01f);
    }

    @Test
    public void largeFullNeedsEnoughHeightForTheTimeRow() {
        WidgetLayouts.Metrics m = phone(true);
        // 文字 16sp + 12sp 按 1.45 倍行高、时间 10sp、按钮 46、上下留白 14
        float hFull = 28 + (16 * 1.45f + 2 + 12 * 1.45f) + 6 + 3 + 3 + 10 * 1.45f + 2 + 46;
        // 桌面比大小时有 1dp 多的余量（ceil(实际) + 1 > 格子），差 3dp 才算放不下
        assertEquals(WidgetLayouts.LARGE_COMPACT, WidgetLayouts.pick(WidgetLayouts.large(m), 360, hFull - 3).kind);
        assertEquals(WidgetLayouts.LARGE_FULL, WidgetLayouts.pick(WidgetLayouts.large(m), 360, hFull + 1).kind);
    }

    @Test
    public void smallSquareKeepsAllThreeButtonsOnNarrowPhones() {
        // 手机上常见的 2×2 只有 150–165dp 宽：三个正常大小的按钮放不下，换小一号的，不收按钮
        WidgetLayouts.Variant v = WidgetLayouts.pick(WidgetLayouts.small(phone(true)), 158, 190);
        assertEquals(WidgetLayouts.SMALL_TALL, v.kind);
        assertTrue(v.compact);
        assertTrue(v.prev && v.next && v.heart);

        WidgetLayouts.Variant wide = WidgetLayouts.pick(WidgetLayouts.small(phone(true)), 200, 190);
        assertEquals(WidgetLayouts.SMALL_TALL, wide.kind);
        assertFalse("够宽就用正常大小", wide.compact);
    }

    @Test
    public void smallSquareOnAShortGridDropsTheBrandRowNotTheTitle() {
        // 小米规范里的 2×2 最小只有 110dp 高：放不下字标那一行，歌名和收藏并成一行
        WidgetLayouts.Variant v = WidgetLayouts.pick(WidgetLayouts.small(phone(true)), 150, 110);
        assertEquals(WidgetLayouts.SMALL_SHORT, v.kind);
        assertTrue(v.heart);
        assertTrue(v.next);
    }

    @Test
    public void smallOneRowHidesHeartThenPrevious() {
        List<WidgetLayouts.Cell> cells = WidgetLayouts.small(phone(true));
        WidgetLayouts.Variant full = WidgetLayouts.pick(cells, 300, 60);
        assertEquals(WidgetLayouts.SMALL_ROW, full.kind);
        assertTrue(full.prev && full.next && full.heart);

        WidgetLayouts.Variant mid = WidgetLayouts.pick(cells, 230, 60);
        assertTrue(mid.prev && mid.next);
        assertFalse(mid.heart);

        WidgetLayouts.Variant narrow = WidgetLayouts.pick(cells, 180, 60);
        assertFalse(narrow.prev);
        assertTrue(narrow.next);

        WidgetLayouts.Variant tiny = WidgetLayouts.pick(cells, 110, 48);
        assertFalse(tiny.prev || tiny.next || tiny.heart);
    }

    @Test
    public void smallStretchedToFourByTwoStaysASquareLayout() {
        // 以前「宽是高的两倍以上才用横条」；现在按格子挑，4×2 大小的小号仍是方块（不会变成一条细横条悬在中间）
        WidgetLayouts.Variant v = WidgetLayouts.pick(WidgetLayouts.small(phone(true)), 300, 180);
        assertEquals(WidgetLayouts.SMALL_TALL, v.kind);
    }

    @Test
    public void legacySystemsHideButtonsInsteadOfResizing() {
        WidgetLayouts.Variant v = WidgetLayouts.pick(WidgetLayouts.small(phone(false)), 150, 190);
        assertFalse("老系统改不了按钮大小", v.compact);
        assertFalse(v.prev);
        assertTrue(v.next);
    }

    @Test
    public void pickFallsBackToTheSmallestWhenNothingFits() {
        List<WidgetLayouts.Cell> cells = WidgetLayouts.large(phone(true));
        WidgetLayouts.Variant v = WidgetLayouts.pick(cells, 10, 10);
        assertEquals(WidgetLayouts.LARGE_ROW, v.kind);
        assertEquals(0f, v.cover, 0.01f);
    }

    @Test
    public void largeOneRowOnTheHonorTabletIsAStrip() {
        // 荣耀平板上把大号压成一行：实际 417×112dp。以前用的是矮排法，要 136dp 高，播放键下半截被切掉
        WidgetLayouts.Metrics m = tablet();
        WidgetLayouts.Variant v = WidgetLayouts.pick(WidgetLayouts.large(m), 417, 112);
        assertEquals(WidgetLayouts.LARGE_ROW, v.kind);
        assertTrue("放得下", WidgetLayouts.minHeight(v.kind, m) <= 112);
        assertTrue("还有收藏", v.heart);
        assertTrue("还有封面", v.cover >= 40);
    }

    @Test
    public void largeOneRowKeepsRoomForTheTitle() {
        for (WidgetLayouts.Metrics m : new WidgetLayouts.Metrics[] { phone(true), phone(false), tablet() }) {
            List<WidgetLayouts.Cell> cells = WidgetLayouts.large(m);
            for (int w = 250; w <= 700; w += 3) {
                WidgetLayouts.Variant v = WidgetLayouts.pick(cells, w, 80);
                assertEquals(WidgetLayouts.LARGE_ROW, v.kind);
                float used = 2 * m.padCompact + 8 + 2 * m.buttonCompact + m.playCompact
                    + (v.heart ? m.heart : 0) + (v.cover > 0 ? v.cover + m.gap : 0);
                // 桌面比大小有 1dp 多的余量：差一点点也算放得下
                assertTrue(w + " " + v + " 歌名至少 72dp", w - used >= 72 - 1.5f);
            }
        }
    }

    @Test
    public void everyPickedLayoutFitsItsHeight() {
        // 桌面挑出来的排法，在那个高度上不能切东西（桌面比大小有 1dp 多的余量）
        for (WidgetLayouts.Metrics m : new WidgetLayouts.Metrics[] { phone(true), phone(false), tablet() }) {
            List<WidgetLayouts.Cell> large = WidgetLayouts.large(m);
            List<WidgetLayouts.Cell> small = WidgetLayouts.small(m);
            for (int w = 110; w <= 700; w += 7) {
                for (int h = 64; h <= 420; h += 3) {
                    WidgetLayouts.Variant s = WidgetLayouts.pick(small, w, h);
                    assertTrue("small " + w + "x" + h + " " + s, WidgetLayouts.minHeight(s.kind, m) <= h + 2);
                    if (w < 250 || h < 110) continue;
                    WidgetLayouts.Variant l = WidgetLayouts.pick(large, w, h);
                    assertTrue("large " + w + "x" + h + " " + l, WidgetLayouts.minHeight(l.kind, m) <= h + 2);
                }
            }
        }
    }
}
