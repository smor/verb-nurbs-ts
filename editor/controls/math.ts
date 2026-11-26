// The arithmetic of number controls: ranges at the value's scale, steps with modifiers, snapping without floating-point
// drift, and display to the step's precision. Pure; no React, no DOM.

/** A number's presentation: its range and step, all optional (missing ones come from the value, see `defaults`). */
export interface Range { min? : number, max? : number, step? : number }

/** 1, 2 or 5 times a power of ten, the nearest at or above x (x > 0). */
export function niceCeil( x : number ) : number {
    const p = Math.pow( 10, Math.floor( Math.log10( x ) ) );
    for (const m of [1, 2, 5, 10]) if (m * p >= x * (1 - 1e-12)) return m * p;
    return 10 * p;
}

/** 1, 2 or 5 times a power of ten, the nearest at or below x (x > 0). */
export function niceFloor( x : number ) : number {
    const p = Math.pow( 10, Math.floor( Math.log10( x ) ) );
    for (const m of [5, 2, 1]) if (m * p <= x * (1 + 1e-12)) return m * p;
    return p;
}

/**
 * A range and step at the scale of a value, for a parameter that gives none: from 0 to about three times the value
 * (rounded up to 1, 2 or 5 × 10ⁿ), a step of about a hundredth of that span (rounded down the same way), whole steps
 * for whole numbers. 3 → 0..10 by 0.1; 0.17 → 0..1 by 0.01; 112 → 0..500 by 5; 3 (whole) → 0..10 by 1.
 * A negative value gets the mirror range; 0 gets 0..10 by 0.1.
 */
export function defaults( value : number, whole = false ) : Required<Range> {
    const a = Math.abs( value );
    if (!(a > 0) || !isFinite( a )) return { min : 0, max : 10, step : whole ? 1 : 0.1 };
    const span = niceCeil( 3 * a );
    let step = niceFloor( span / 100 );
    if (whole) step = Math.max( 1, Math.round( step ) );
    return value < 0 ? { min : -span, max : 0, step } : { min : 0, max : span, step };
}

/**
 * The range to show for a value, from what is given and what is sensible: given bounds win; a missing step comes from
 * the span; a missing range comes from `defaults`. A given range far wider than the value's scale (a catalogue's
 * 0.01..1000 for a 20 mm width) is replaced by `defaults` when `tame` is set and the value sits in its bottom 3 %.
 */
export function resolve( value : number, given : Range = {}, whole = false, tame = false ) : Required<Range> {
    const d = defaults( value, whole );
    let min = given.min ?? d.min, max = given.max ?? d.max;
    if (tame && given.min != null && given.max != null && isFinite( value ) && value > 0 && (value - given.min) < 0.03 * (given.max - given.min)) {
        min = Math.max( given.min, d.min ); max = Math.min( given.max, d.max );
    }
    if (!(max > min)) { min = d.min; max = d.max; }
    let step = given.step ?? niceFloor( (max - min) / 100 );
    if (whole) step = Math.max( 1, Math.round( step ) );
    return { min, max, step };
}

/** How many decimals a step has (0.005 → 3, 0.1 → 1, 5 → 0), from its shortest decimal form. */
export function decimals( step : number ) : number {
    const s = String( step );
    if (s.includes( "e-" )) return Number( s.split( "e-" )[1] ) + (s.split( "e" )[0].split( "." )[1]?.length ?? 0);
    return s.split( "." )[1]?.length ?? 0;
}

/** A value rounded to the step's decimals, so 0.1 + 0.2 is 0.3 and never 0.30000000000000004. */
export function tidy( v : number, step : number ) : number {
    return Number( v.toFixed( Math.min( 12, decimals( step ) + 2 ) ) );
}

/** A value snapped to the nearest multiple of the step counted from `origin` (default 0). */
export function snap( v : number, step : number, origin = 0 ) : number {
    return tidy( origin + Math.round( (v - origin) / step ) * step, step );
}

/** The step a gesture moves by: × 10 with Shift, ÷ 10 with Alt (or Option), the step itself otherwise. */
export function stepFor( step : number, mods : { shift? : boolean, alt? : boolean } ) : number {
    return mods.shift ? step * 10 : mods.alt ? step / 10 : step;
}

/**
 * The value after n steps of a gesture: from v by n × stepFor(step, mods). With the plain step it lands on the step's
 * grid (a field showing 3.04 steps up to 3.1, not 3.14); a fine step keeps the value's own grid.
 */
export function stepped( v : number, n : number, step : number, mods : { shift? : boolean, alt? : boolean } = {} ) : number {
    const s = stepFor( step, mods );
    if (mods.alt) return tidy( v + n * s, s );
    const base = snap( v, s );
    const moved = base == v || n == 0 ? base + n * s : (n > 0 ? (base > v ? base : base + s) + (n - 1) * s : (base < v ? base : base - s) + (n + 1) * s);
    return tidy( moved, s );
}

/** A value held between min and max. */
export function clamp( v : number, r : { min : number, max : number } ) : number {
    return Math.min( r.max, Math.max( r.min, v ) );
}

/** How a value shows in a field: at the step's precision, without trailing zeros (3, 3.1, 0.17, 0.005). */
export function format( v : number, step : number ) : string {
    if (!isFinite( v )) return String( v );
    return String( Number( v.toFixed( Math.min( 12, Math.max( decimals( step ), decimals( v ) > 6 ? 6 : decimals( v ) ) ) ) ) );
}

/** A scrub's value change: one step per `pxPerStep` pixels dragged, with the gesture's modifiers. */
export function scrubbed( start : number, dx : number, step : number, mods : { shift? : boolean, alt? : boolean } = {}, pxPerStep = 4 ) : number {
    const s = stepFor( step, mods );
    return tidy( start + Math.round( dx / pxPerStep ) * s, s );
}
