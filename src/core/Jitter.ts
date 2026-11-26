// A deterministic stand-in for Math.random where an algorithm only needs to avoid a symmetric split (the middle of a
// domain landing exactly on a feature): a value in [0, 1) drawn from the bits of its inputs. The same inputs give the
// same value in every run, on every machine, and whatever was computed before, so results are reproducible byte for
// byte (#68 A2). The mixing is the 32-bit finaliser of MurmurHash3 (Appleby, "MurmurHash3", 2011).
const bits = new Float64Array( 1 ), words = new Uint32Array( bits.buffer );

export function jitter( ...values : Array<number> ) : number {
    let h = 0x9e3779b9;
    for (const v of values) {
        bits[0] = v;
        for (let k = 0; k < 2; k++) {
            h = Math.imul( h ^ words[k], 0x85ebca6b );
            h ^= h >>> 13;
            h = Math.imul( h, 0xc2b2ae35 );
            h ^= h >>> 16;
        }
    }
    return (h >>> 0) / 4294967296;
}
