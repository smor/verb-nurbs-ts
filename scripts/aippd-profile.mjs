// The half-section of a vessel, from a profile mask as AIPPD stores them: 256 × 256 pixels, the section filled, the
// axis of rotation at the right edge of the profile's box. `get(y, x)` is 1 inside the section; y = 0 is the top row.
// The real size comes from the vessel's height (cm): the box's height in pixels is that height.
//
// Returns { outer, cavity, foot, mmPerPx, heightMm }, each profile an array of [r, z] in millimetres from the base up,
// as `freeform/vessel` takes them:
//   outer:  the outside, row by row, from z = 0 to the rim;
//   cavity: the room between the wall and the axis, from its floor to 3 mm above the rim (so the mouth is open), or
//           null for a solid shape;
//   foot:   the room under the base, from 3 mm below z = 0 to its roof, or null when the base is flat.
// Each is `samples` rows evenly spaced through its height. A profile whose wall leaves the axis more than once in
// height (a rim folded back down) keeps only its outermost extent per row.

/** mm of clearance above the rim and below the base, so the cavity and the hollow foot open through. */
export const OPEN_MM = 3;

export function profile( get, heightCm, samples = 22 ) {
    // the axis: the right side of the profile's rightmost pixel
    let ax = -1;
    for (let y = 0; y < 256; y++) for (let x = 255; x > ax; x--) if (get( y, x )) { ax = x; break; }
    if (ax < 0) throw new Error( "aippd: an empty profile" );
    const axis = ax + 1;
    const byY = {};
    const filled = [];
    for (let y = 0; y < 256; y++) {
        let left = -1, right = -1;
        for (let x = 0; x < 256; x++) if (get( y, x )) { if (left < 0) left = x; right = x; }
        if (left < 0) continue;
        // out: the outer radius; inner: the room between the wall's inner side and the axis (0 when the row is solid)
        byY[y] = { out : axis - left, inner : axis - 1 - right };
        filled.push( y );
    }
    const top = filled[0], bottom = filled[filled.length - 1];
    const s = heightCm * 10 / (bottom - top + 1);
    const z = ( y ) => (bottom + 1 - y) * s;
    const pick = ( ys, f ) => {
        const k = Math.min( samples, ys.length ), out = [];
        for (let i = 0; i < k; i++) out.push( f( ys[Math.round( i * (ys.length - 1) / (k - 1) )] ) );
        return out;
    };
    const outer = pick( filled.slice().reverse(), y => [byY[y].out * s, z( y ) - 0.5 * s] );
    outer[0][1] = 0;
    outer[outer.length - 1][1] = z( top );
    const open = ( y ) => byY[y] != null && byY[y].inner >= 1;
    const cav = [];
    for (let y = top; y <= bottom && open( y ); y++) cav.push( y );
    let cavity = null;
    if (cav.length >= 3) {
        cavity = pick( cav.slice().reverse(), y => [byY[y].inner * s, z( y ) - 0.5 * s] );
        cavity[0][1] = z( cav[cav.length - 1] ) - s;
        cavity[cavity.length - 1][1] = z( top ) + OPEN_MM;
    }
    const ft = [];
    for (let y = bottom; y >= top && open( y ); y--) ft.push( y );
    let foot = null;
    // a hollow under the base, apart from the cavity by two rows or more
    if (ft.length >= 3 && (cav.length == 0 || ft[ft.length - 1] > cav[cav.length - 1] + 2)) {
        foot = pick( ft, y => [byY[y].inner * s, z( y ) - 0.5 * s] );
        foot[0][1] = -OPEN_MM;
        foot[foot.length - 1][1] = z( ft[ft.length - 1] ) + s;
    }
    return { outer, cavity, foot, mmPerPx : s, heightMm : z( top ) };
}
