package cn.baogutang.musicstreampro.widget;

import java.util.ArrayList;
import java.util.List;

/**
 * 小部件在各种大小下怎么排：放不放封面、封面最大多大、按钮用正常的还是小一号的、哪几个按钮先收起来。
 *
 * 结果是一张「宽 × 高」的格子表，每一格是一种排法。Android 12 起整张表交给桌面
 * （{@code RemoteViews(Map<SizeF, RemoteViews>)}），桌面按小部件<b>实际排出来的大小</b>挑：
 * 宽、高都不超过实际大小的格子里离它最近的那个——格子是满的（每个宽度都配每个高度），挑中的就是
 * 「宽度取不超过实际的最大一档、高度也是」。这样不用信桌面报给我们的大小（荣耀平板上 4×2 报 399×123dp，
 * 实际是 556×232dp）。Android 12 以前只能自己按报的大小挑一格（{@link #pick}）。
 *
 * 这里只做算术、不碰安卓的类，尺寸都是 dp（字号已经按用户的字体大小换算好），方便单元测试。
 */
final class WidgetLayouts {
    /** 桌面最多接受这么多种排法 */
    static final int MAX_CELLS = 16;
    /**
     * 一行字占多高（字号的倍数）。中文走的是思源黑体一类的后备字体，行高比英文的 Roboto 高（约 1.45 倍对 1.33 倍），
     * 按高的算：宁可多留一点空，不能让歌名被切掉。
     */
    static final float LINE = 1.45f;

    static final int SMALL_TALL = 0;
    static final int SMALL_SHORT = 1;
    static final int SMALL_ROW = 2;
    static final int LARGE_FULL = 3;
    static final int LARGE_COMPACT = 4;

    /** 一种排法 */
    static final class Variant {
        final int kind;
        /** 播放键这一排用小一号的按钮（只有 Android 12 起能改按钮大小） */
        final boolean compact;
        final boolean prev;
        final boolean next;
        final boolean heart;
        /** 大号：封面最大多大（dp），0 是不放封面 */
        final float cover;

        Variant(int kind, boolean compact, boolean prev, boolean next, boolean heart, float cover) {
            this.kind = kind;
            this.compact = compact;
            this.prev = prev;
            this.next = next;
            this.heart = heart;
            this.cover = cover;
        }

        @Override
        public String toString() {
            return "kind=" + kind + (compact ? " compact" : "") + (prev ? "" : " -prev") + (next ? "" : " -next")
                + (heart ? "" : " -heart") + (kind >= LARGE_FULL ? " cover=" + Math.round(cover) : "");
        }
    }

    /** 格子表里的一格：小部件至少有 w × h（dp）时用这种排法 */
    static final class Cell {
        final float w;
        final float h;
        final Variant variant;

        Cell(float w, float h, Variant variant) {
            this.w = w;
            this.h = h;
            this.variant = variant;
        }
    }

    /** 量布局用的尺寸（dp），来自 values / values-sw600dp 里的 widget_dimens */
    static final class Metrics {
        float pad;
        float padCompact;
        float gap;
        float button;
        float buttonCompact;
        float play;
        float playCompact;
        float heart;
        float title;
        float artist;
        float time;
        float brand;
        float progress;
        float coverMax;
        float coverMin;
        /** 按钮能不能临时改小（Android 12 起的 setViewLayoutWidth）；老系统上窄了只能收起按钮 */
        boolean canResize;

        float textBlock() {
            return title * LINE + 2 + artist * LINE;
        }
    }

    private WidgetLayouts() {}

    /* ---------------------------------------------------------------- 小号 */

    /**
     * 小号的三种排法（布局文件在 res/layout）：
     * - 方块（widget_small）：上面字标和收藏，中间歌名歌手，下面三个按钮；
     * - 矮方块（widget_small_short）：歌名歌手和收藏一行，下面三个按钮——2×2 但格子矮的桌面；
     * - 横条（widget_small_wide）：只有一行高的时候，歌名歌手在左、按钮在右，窄了先收收藏、再收上一首。
     */
    static List<Cell> small(Metrics m) {
        float playShort = m.canResize ? m.playCompact : m.play;
        float hShort = 10 + Math.max(m.textBlock(), m.heart) + 4 + playShort + 10;
        float hTall = 10 + Math.max(m.brand * LINE, m.heart) + m.textBlock() + 4 + m.play + 12;

        // 方块里三个按钮平分一排，每份至少要放得下播放键；左右留白 = pad + 8 + 6（见布局）
        float squareChrome = m.pad + 14;
        float wSquareNormal = squareChrome + 3 * m.play;
        float wSquareCompact = squareChrome + 3 * m.playCompact;
        // 横条：左边 pad、右边 8，字和按钮之间 8，字至少留 56dp；收藏连两边的间距和一个按钮一样宽
        float rowChrome = m.pad + 8 + 8 + 56;
        float wRowFull = rowChrome + 3 * m.button + m.play;
        float wRowNoHeart = rowChrome + 2 * m.button + m.play;
        float wRowNoPrev = rowChrome + m.button + m.play;

        float[] widths = distinct(0, m.canResize ? wSquareCompact : 0, Math.max(wSquareNormal, wRowNoPrev), wRowNoHeart, wRowFull);
        float[] heights = { 0, hShort, hTall };
        List<Cell> cells = new ArrayList<>();
        for (float h : heights) {
            for (float w : widths) {
                Variant v;
                if (h >= hTall || h >= hShort) {
                    int kind = h >= hTall ? SMALL_TALL : SMALL_SHORT;
                    boolean shortCompact = kind == SMALL_SHORT && m.canResize;
                    if (w >= wSquareNormal && !shortCompact) {
                        v = new Variant(kind, false, true, true, true, 0);
                    } else if (m.canResize && w >= wSquareCompact) {
                        v = new Variant(kind, true, true, true, true, 0);
                    } else {
                        // 再窄：收起上一首，剩播放和下一首
                        v = new Variant(kind, m.canResize, false, true, true, 0);
                    }
                } else if (w >= wRowFull) {
                    v = new Variant(SMALL_ROW, false, true, true, true, 0);
                } else if (w >= wRowNoHeart) {
                    v = new Variant(SMALL_ROW, false, true, true, false, 0);
                } else if (w >= wRowNoPrev) {
                    v = new Variant(SMALL_ROW, false, false, true, false, 0);
                } else {
                    v = new Variant(SMALL_ROW, m.canResize, false, false, false, 0);
                }
                cells.add(new Cell(w, h, v));
            }
        }
        return cells;
    }

    /* ---------------------------------------------------------------- 大号 */

    /**
     * 大号：左边封面，右边歌名歌手、收藏、进度条、时间、三个按钮。
     * 封面是正方形、边长跟着高度走，但不能把右边挤得放不下三个按钮：宽度不够时封面跟着缩，再窄就不放封面。
     * 矮的时候（格子矮的手机）去掉时间那一行、留白和按钮都收小一号。
     */
    static List<Cell> large(Metrics m) {
        float hFull = 2 * m.pad + Math.max(m.textBlock(), m.heart) + 6 + m.progress + 3 + m.time * LINE + 2 + m.play;
        float controlsFull = controls(m, false);

        List<Float> widthList = new ArrayList<>();
        widthList.add(0f);
        int steps = 4;
        for (int i = 0; i <= steps; i++) {
            float cover = m.coverMin + (m.coverMax - m.coverMin) * i / steps;
            widthList.add(2 * m.pad + cover + m.gap + controlsFull);
        }
        float[] heights = { 0, hFull };
        List<Cell> cells = new ArrayList<>();
        for (float h : heights) {
            boolean full = h >= hFull;
            for (float w : widthList) {
                float pad = full ? m.pad : m.padCompact;
                float room = w - 2 * pad - m.gap - controls(m, !full);
                float cover = Math.min(m.coverMax, room);
                if (cover < m.coverMin) cover = 0;
                cells.add(new Cell(w, h, new Variant(full ? LARGE_FULL : LARGE_COMPACT, !full && m.canResize, true, true, true, cover)));
            }
        }
        return cells;
    }

    /** 右边那一栏至少要多宽：三个按钮平分，每份放得下播放键，再留一点 */
    private static float controls(Metrics m, boolean compact) {
        float play = compact && m.canResize ? m.playCompact : m.play;
        return 3 * play + 6;
    }

    /* ---------------------------------------------------------------- 挑一格 */

    /** 和桌面一样挑：宽、高都不超过的格子里最近的那个；一个都放不下就用最小的 */
    static Variant pick(List<Cell> cells, float w, float h) {
        Cell best = null;
        float bestDistance = Float.MAX_VALUE;
        Cell smallest = null;
        for (Cell cell : cells) {
            if (smallest == null || cell.w * cell.h < smallest.w * smallest.h) smallest = cell;
            // 桌面的判断：Math.ceil(实际) + 1 > 格子
            if (Math.ceil(w) + 1 > cell.w && Math.ceil(h) + 1 > cell.h) {
                float dw = w - cell.w;
                float dh = h - cell.h;
                float distance = dw * dw + dh * dh;
                if (distance < bestDistance) {
                    best = cell;
                    bestDistance = distance;
                }
            }
        }
        return (best != null ? best : smallest).variant;
    }

    /** 去掉重复和挨得太近（不到 1dp）的宽度，从小到大 */
    private static float[] distinct(float... values) {
        float[] sorted = values.clone();
        java.util.Arrays.sort(sorted);
        float[] out = new float[sorted.length];
        int n = 0;
        for (float v : sorted) {
            if (n == 0 || v - out[n - 1] >= 1) out[n++] = v;
        }
        return java.util.Arrays.copyOf(out, n);
    }
}
