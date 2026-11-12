package cn.baogutang.musicstreampro;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;

import org.junit.Test;

public class FlacPictureStripperTest {

    /** fLaC + STREAMINFO(34) + VORBIS(10) + PICTURE(300, 坏的) + SEEKTABLE(18) + PADDING(last, 8) + 一段音频帧 */
    private static byte[] sample() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write('f'); out.write('L'); out.write('a'); out.write('C');
        block(out, 0, false, 34, 0x11);
        block(out, 4, false, 10, 0x22);
        block(out, 6, false, 300, 0xff);
        block(out, 3, false, 18, 0x33);
        block(out, 1, true, 8, 0x00);
        for (int i = 0; i < 64; i++) out.write(i == 0 ? 0xff : i == 1 ? 0xf8 : 0x5a);
        return out.toByteArray();
    }

    private static void block(ByteArrayOutputStream out, int type, boolean last, int len, int fill) {
        out.write((last ? 0x80 : 0) | type);
        out.write((len >> 16) & 0xff);
        out.write((len >> 8) & 0xff);
        out.write(len & 0xff);
        for (int i = 0; i < len; i++) out.write(fill);
    }

    /** 按给定大小切段喂进去，拼回来 */
    private static byte[] run(byte[] input, int chunk, FlacPictureStripper s) {
        byte[] copy = input.clone();
        for (int off = 0; off < copy.length; off += chunk) {
            int n = Math.min(chunk, copy.length - off);
            byte[] part = Arrays.copyOfRange(copy, off, off + n);
            s.process(part, n);
            System.arraycopy(part, 0, copy, off, n);
        }
        return copy;
    }

    @Test
    public void pictureBlockBecomesPaddingAndNothingElseChanges() {
        byte[] input = sample();
        int pictureHeader = 4 + (4 + 34) + (4 + 10);
        for (int chunk : new int[] {1, 2, 3, 5, 7, 64, 4096}) {
            FlacPictureStripper s = new FlacPictureStripper();
            byte[] out = run(input, chunk, s);
            assertEquals("chunk " + chunk, 1, out[pictureHeader]);
            assertEquals(1, s.stripped());
            assertFalse(s.active());
            byte[] expected = input.clone();
            expected[pictureHeader] = 1;
            assertArrayEquals("chunk " + chunk, expected, out);
        }
    }

    @Test
    public void lastFlagIsKeptWhenThePictureIsTheLastBlock() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write('f'); out.write('L'); out.write('a'); out.write('C');
        block(out, 0, false, 34, 0x11);
        block(out, 6, true, 20, 0xff);
        byte[] input = out.toByteArray();
        byte[] result = run(input, 16, new FlacPictureStripper());
        assertEquals((byte) 0x81, result[4 + 38]);
    }

    @Test
    public void nonFlacStreamsPassThroughUntouched() {
        byte[] mp3 = new byte[200];
        mp3[0] = 'I'; mp3[1] = 'D'; mp3[2] = '3';
        Arrays.fill(mp3, 10, 200, (byte) 0x06);
        FlacPictureStripper s = new FlacPictureStripper();
        byte[] result = run(mp3, 7, s);
        assertArrayEquals(mp3, result);
        assertFalse(s.active());
        assertEquals(0, s.stripped());
    }
}
