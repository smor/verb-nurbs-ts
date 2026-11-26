// The shelf: every output of a graph shown at once, side by side, as in a museum case. Pure: no DOM, no three.js.
//
// A document may say where each output goes (`view.shelf`): rows (top to bottom) and columns (left to right) by key,
// and `place[output] = [rowKey, columnKey]`. Without it, outputs fill a grid in their order. Each row is as tall as
// its tallest piece, each column as wide as its widest, so pieces of very different sizes keep their true scale.

/** Where the document puts its outputs on the shelf. */
export interface ShelfSpec {
    rows : Array<{ key : string, label : string, note? : string }>;
    columns : Array<{ key : string, label : string }>;
    place : { [output : string] : [string, string] };
}

/** A piece's box, as built: x and y across, z up. */
export interface Box { min : [number, number, number], max : [number, number, number] }

/** The layout: how far to move each piece, and where the row and column labels go. */
export interface ShelfLayout {
    move : { [output : string] : [number, number, number] };
    rows : Array<{ label : string, note? : string, z : number, height : number }>;
    columns : Array<{ label : string, x : number, width : number }>;
    size : [number, number];
}

/** The gap between pieces, as a share of the largest piece's size, and never under `minGap` (mm). */
export const GAP = 0.25;

/**
 * Lays the pieces out: each centred in its column on x and y, standing on its row's floor. Rows go down the z axis
 * from z = 0 (the first row is on top), columns along +x. Pieces with no place, or whose row or column is not in
 * `spec`, go after the last row, in a row of their own.
 */
export function layout( boxes : { [output : string] : Box }, spec : ShelfSpec | null, minGap = 5 ) : ShelfLayout {
    const names = Object.keys( boxes );
    const size = ( b : Box ) => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    const largest = Math.max( 1, ...names.map( n => Math.max( ...size( boxes[n] ) ) ) );
    const gap = Math.max( minGap, GAP * largest );
    let rows : Array<{ key : string, label : string, note? : string }>, columns : Array<{ key : string, label : string }>;
    const at : { [output : string] : [number, number] } = {};
    if (spec != null) {
        rows = spec.rows.slice(); columns = spec.columns.slice();
        const extra : Array<string> = [];
        for (const n of names) {
            const p = spec.place[n];
            const r = p == null ? -1 : rows.findIndex( x => x.key == p[0] ), c = p == null ? -1 : columns.findIndex( x => x.key == p[1] );
            if (r < 0 || c < 0) extra.push( n ); else at[n] = [r, c];
        }
        if (extra.length > 0) {
            rows.push( { key : "", label : "" } );
            extra.forEach( ( n, i ) => {
                while (columns.length <= i) columns.push( { key : "", label : "" } );
                at[n] = [rows.length - 1, i];
            } );
        }
    } else {
        const k = Math.max( 1, Math.ceil( Math.sqrt( names.length ) ) );
        rows = Array.from( { length : Math.ceil( names.length / k ) }, () => ({ key : "", label : "" }) );
        columns = Array.from( { length : Math.min( k, names.length ) }, () => ({ key : "", label : "" }) );
        names.forEach( ( n, i ) => { at[n] = [Math.floor( i / k ), i % k]; } );
    }
    const height = rows.map( () => 0 ), width = columns.map( () => 0 );
    for (const n of names) {
        const [r, c] = at[n], s = size( boxes[n] );
        height[r] = Math.max( height[r], s[2] );
        width[c] = Math.max( width[c], s[0], s[1] );
    }
    // empty rows and columns (no piece built yet) keep a little room, so the grid does not jump much as pieces arrive
    const xs : Array<number> = [], zs : Array<number> = [];
    let x = 0;
    for (let c = 0; c < columns.length; c++) { xs.push( x ); x += (width[c] || largest * 0.3) + gap; }
    let z = 0;
    for (let r = 0; r < rows.length; r++) { z -= (height[r] || largest * 0.3); zs.push( z ); z -= gap; }
    const move : ShelfLayout["move"] = {};
    for (const n of names) {
        const [r, c] = at[n], b = boxes[n];
        const cx = xs[c] + (width[c] || largest * 0.3) / 2;
        move[n] = [cx - (b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, zs[r] - b.min[2]];
    }
    return {
        move,
        rows : rows.map( ( r, i ) => ({ label : r.label, note : r.note, z : zs[i], height : height[i] || largest * 0.3 }) ),
        columns : columns.map( ( c, i ) => ({ label : c.label, x : xs[i], width : width[i] || largest * 0.3 }) ),
        size : [x - gap, -(z + gap)],
    };
}
