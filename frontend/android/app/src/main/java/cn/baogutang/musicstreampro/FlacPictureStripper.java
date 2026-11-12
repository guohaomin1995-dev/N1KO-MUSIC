package cn.baogutang.musicstreampro;

/**
 * 转发 FLAC 时，把文件头里的「图片」元数据块改记成「填充」块。
 *
 * 有些 FLAC 内嵌的封面块写坏了（图片类型 0xFFFFFFFF、MIME 为空——标签软件留下的），
 * 电脑上的播放器不管它，WebView（Chrome 的 FFmpeg）却会因此整个文件打不开：
 * DEMUXER_ERROR_COULD_NOT_OPEN，播放器报错误码 4。
 *
 * 播放器用不着内嵌封面（封面走 getCoverArt），所以这里一律只改块头那一个字节：
 * 类型 6（PICTURE）→ 1（PADDING），长度不变。文件大小、每个字节的偏移都和原文件一样，
 * Range 续传照旧对得上；填充块的内容解码器直接跳过。只处理从文件开头（偏移 0）
 * 开始的响应——文件头只在那里；不是 fLaC 开头的流第 4 个字节就放手。
 */
final class FlacPictureStripper {
    private static final byte[] MAGIC = {'f', 'L', 'a', 'C'};
    private static final int TYPE_PADDING = 1;
    private static final int TYPE_PICTURE = 6;

    /** 下一个要处理的字节在文件里的偏移 */
    private long pos = 0;
    /** 下一个元数据块头的偏移（紧跟 fLaC 的是 STREAMINFO 的块头） */
    private long nextHeader = 4;
    private int length = 0;
    private boolean last = false;
    private boolean active = true;
    private int stripped = 0;

    /** 还在看文件头；false 之后调用方可以不再调 {@link #process} */
    boolean active() {
        return active;
    }

    /** 改掉了几个图片块 */
    int stripped() {
        return stripped;
    }

    /** 按顺序喂入响应体的每一段（就地修改） */
    void process(byte[] buf, int n) {
        long base = pos;
        pos += n;
        for (int i = 0; i < n && active; i++) {
            long p = base + i;
            int b = buf[i] & 0xff;
            if (p < 4) {
                if (b != MAGIC[(int) p]) active = false;
                continue;
            }
            if (p < nextHeader) {
                // 块体：整段跳到下一个块头（大图片块有几 MB，不逐字节看）
                long skip = nextHeader - p;
                if (skip > n - i) return;
                i += (int) skip - 1;
                continue;
            }
            int k = (int) (p - nextHeader);
            if (k == 0) {
                last = (b & 0x80) != 0;
                int type = b & 0x7f;
                if (type == 127) {
                    // 127 是规范里的非法类型：不是一个能看懂的文件头，放手
                    active = false;
                    continue;
                }
                if (type == TYPE_PICTURE) {
                    buf[i] = (byte) ((b & 0x80) | TYPE_PADDING);
                    stripped++;
                }
                length = 0;
            } else {
                length = (length << 8) | b;
                if (k == 3) {
                    if (last) active = false;
                    else nextHeader = nextHeader + 4 + length;
                }
            }
        }
    }
}
