// A number control for node editors and parameter panels. Self-contained: React and ./math only.
//
// Every gesture (scrub, hold, slider drag, arrow key) produces preview values while it lasts and one commit at its
// end; the host decides what a preview does (rebuild live when that is cheap, or only move the number). The range is
// soft: typing beyond it is allowed and shown, and the slider widens to include the value. Hard limits (a count of at
// least 1, whole numbers) are the host's, given as `hard`.
//
// Two layouts: `compact` (a node row: a label you drag to scrub, the value with a bar showing where it sits in its
// range, the unit) and full (a panel row: label, −, slider, +, value, unit, and the host's ⋯ button).
import { useEffect, useRef, useState } from "react";
import { clamp, format, scrubbed, stepped, stepFor, tidy } from "./math.js";

export interface NumberFieldProps {
    label : string;
    /** The value: a number, or an expression (text). */
    value : number | string;
    /** For an expression, its current value, shown dimmed. */
    computed? : number | null;
    /** The soft range and the step. */
    range : { min : number, max : number, step : number };
    /** Hard limits: the value never leaves them (a count stays whole and at least 1). */
    hard? : { min? : number, max? : number, integer? : boolean };
    unit? : string;
    /** The value reset restores (double-click the label, or the reset item). */
    defaultValue? : number;
    /** Named values: chips under the slider (full layout) and ticks on it. */
    presets? : Array<{ label : string, value : number }>;
    compact? : boolean;
    /** Previews: the value while a gesture lasts. */
    onPreview( v : number ) : void;
    /** The end of a gesture, or a typed value or expression. `key` names the stream of edits that merge into one step. */
    onCommit( v : number | string, key : string ) : void;
    /** Whether previews rebuild live: asked once at the start of each gesture. */
    live? : () => boolean;
    /** Called with true at the start of a gesture that does not rebuild live, false at its end. */
    onHolding?( holding : boolean ) : void;
    /** The host's menu (range, presets, default): a ⋯ button in the full layout, right-click in both. */
    onMenu?( at : { x : number, y : number } ) : void;
    /** Shows where the parameter is (the host pans to its node): a small button in the full layout. */
    onLocate?() : void;
    id? : string;
}

const HOLD_DELAY = 400, HOLD_FAST = 80, HOLD_FASTER = 40, HOLD_ACCEL = 1500, DEAD_ZONE = 3, KEY_PAUSE = 400;

export function NumberField( p : NumberFieldProps ) {
    const isExpr = typeof p.value == "string";
    const num = typeof p.value == "number" ? p.value : (p.computed ?? NaN);
    const [text, setText] = useState( isExpr ? String( p.value ) : format( num, p.range.step ) );
    const [editing, setEditing] = useState( false );
    const [holding, setHolding] = useState( false );
    const live = useRef( true );
    const shown = useRef( num );
    const gestureStart = useRef<number | null>( null );
    const timer = useRef<number | null>( null ), keyTimer = useRef<number | null>( null );
    useEffect( () => { if (!editing) setText( isExpr ? String( p.value ) : format( num, p.range.step ) ); shown.current = num; }, [p.value, p.computed, p.range.step] );

    const limit = ( v : number ) => {
        let x = v;
        if (p.hard?.integer) x = Math.round( x );
        if (p.hard?.min != null) x = Math.max( p.hard.min, x );
        if (p.hard?.max != null) x = Math.min( p.hard.max, x );
        return x;
    };
    const key = p.id ?? p.label;
    // a gesture: begin (decide live or not), preview values, end with one commit (or a revert)
    const begin = () => {
        if (gestureStart.current != null) return;
        gestureStart.current = shown.current;
        live.current = p.live ? p.live() : true;
        window.addEventListener( "keydown", escape.current, true );
        if (!live.current) { setHolding( true ); p.onHolding?.( true ); }
    };
    const preview = ( v : number ) => {
        const x = limit( v );
        shown.current = x;
        setText( format( x, p.range.step ) );
        p.onPreview( x );
    };
    const end = ( revert = false ) => {
        if (keyTimer.current != null) { clearTimeout( keyTimer.current ); keyTimer.current = null; }
        if (timer.current != null) { clearTimeout( timer.current ); timer.current = null; }
        scrub.current = null;
        if (gestureStart.current == null) return;
        const start = gestureStart.current;
        gestureStart.current = null;
        window.removeEventListener( "keydown", escape.current, true );
        if (holding || !live.current) { setHolding( false ); p.onHolding?.( false ); }
        if (revert) { preview( start ); p.onCommit( start, key ); return; }
        if (shown.current != start) p.onCommit( shown.current, key );
    };

    // scrub: drag the label, one step per 4 px (Shift × 10, Alt ÷ 10); the pointer is captured, Escape reverts
    const scrub = useRef<{ x : number, start : number, moved : boolean, pointer : number } | null>( null );
    const onLabelDown = ( e : React.PointerEvent ) => {
        if (isExpr || e.button != 0) return;
        e.preventDefault();
        (e.target as Element).setPointerCapture( e.pointerId );
        scrub.current = { x : e.clientX, start : shown.current, moved : false, pointer : e.pointerId };
    };
    const onLabelMove = ( e : React.PointerEvent ) => {
        const s = scrub.current;
        if (!s) return;
        const dx = e.clientX - s.x;
        if (!s.moved) {
            if (Math.abs( dx ) < DEAD_ZONE) return;
            s.moved = true;
            begin();
        }
        preview( scrubbed( s.start, dx - Math.sign( dx ) * DEAD_ZONE, p.range.step, { shift : e.shiftKey, alt : e.altKey } ) );
    };
    const onLabelUp = () => {
        const s = scrub.current;
        scrub.current = null;
        if (!s) return;
        if (s.moved) end();
    };
    const endRef = useRef( end );
    endRef.current = end;
    const escape = useRef( ( e : KeyboardEvent ) => { if (e.key == "Escape" && gestureStart.current != null) { e.preventDefault(); endRef.current( true ); } } );
    const beginGesture = begin;
    useEffect( () => () => window.removeEventListener( "keydown", escape.current, true ), [] );

    // − and +: one step a click; held, they repeat (400 ms, then every 80, every 40 after 1.5 s); one commit on release
    const stepOnce = ( n : number, e : { shiftKey : boolean, altKey : boolean } ) => preview( stepped( shown.current, n, p.range.step, { shift : e.shiftKey, alt : e.altKey } ) );
    const onStepDown = ( n : number ) => ( e : React.PointerEvent ) => {
        if (isExpr || e.button != 0) return;
        e.preventDefault();
        begin();
        stepOnce( n, e );
        const t0 = performance.now(), mods = { shiftKey : e.shiftKey, altKey : e.altKey };
        const tick = () => { stepOnce( n, mods ); timer.current = window.setTimeout( tick, performance.now() - t0 > HOLD_ACCEL ? HOLD_FASTER : HOLD_FAST ); };
        timer.current = window.setTimeout( tick, HOLD_DELAY );
    };
    const onStepUp = () => { if (timer.current != null) { clearTimeout( timer.current ); timer.current = null; } end(); };

    // the field: type a number or an expression; ↑/↓ step (Shift, Alt), Home/End go to the range's ends; Enter commits,
    // Escape reverts. Repeated arrow presses merge into one undo step (the host merges a key's stream)
    const commitText = () => {
        if (gestureStart.current != null) { end(); setEditing( false ); return; }
        setEditing( false );
        const t = text.trim();
        if (t == "") { setText( isExpr ? String( p.value ) : format( num, p.range.step ) ); return; }
        if (!isNaN( +t )) { const x = limit( +t ); setText( format( x, p.range.step ) ); if (x !== p.value) p.onCommit( x, key ); }
        else if (t !== p.value) p.onCommit( t, key );
    };
    const onKey = ( e : React.KeyboardEvent<HTMLInputElement> ) => {
        if (e.key == "Enter") { (e.target as HTMLInputElement).blur(); return; }
        if (e.key == "Escape") { setEditing( false ); setText( isExpr ? String( p.value ) : format( num, p.range.step ) ); (e.target as HTMLInputElement).blur(); return; }
        if (isExpr && isNaN( +text )) return;
        // from what is typed, when it is a number not yet committed
        const from = editing && text.trim() != "" && !isNaN( +text ) ? +text : shown.current;
        let x : number | null = null;
        if (e.key == "ArrowUp" || e.key == "ArrowDown") x = stepped( from, e.key == "ArrowUp" ? 1 : -1, p.range.step, { shift : e.shiftKey, alt : e.altKey } );
        else if (e.key == "Home") x = p.range.min;
        else if (e.key == "End") x = p.range.max;
        if (x == null) return;
        e.preventDefault();
        beginGesture();
        preview( x );
        if (keyTimer.current != null) clearTimeout( keyTimer.current );
        keyTimer.current = window.setTimeout( () => end(), KEY_PAUSE );
    };

    // where the value sits in its range: the bar behind a compact value, and the slider's span (widened to the value)
    // the slider's span: the range, widened by whole steps to include an out-of-range value (so it keeps the step's grid)
    const st = p.range.step;
    const lo = isFinite( num ) && num < p.range.min ? tidy( p.range.min - Math.ceil( (p.range.min - num) / st - 1e-9 ) * st, st ) : p.range.min;
    const hi = isFinite( num ) && num > p.range.max ? tidy( p.range.max + Math.ceil( (num - p.range.max) / st - 1e-9 ) * st, st ) : p.range.max;
    const out = isFinite( num ) && (num < p.range.min || num > p.range.max);
    const frac = isFinite( num ) && hi > lo ? (clamp( num, { min : lo, max : hi } ) - lo) / (hi - lo) : 0;
    const unit = p.unit ? " " + p.unit : "";
    const title = out ? `Outside ${format( p.range.min, p.range.step )}–${format( p.range.max, p.range.step )}${unit} (allowed)` : undefined;
    const reset = p.defaultValue != null && !isExpr ? () => { begin(); preview( p.defaultValue! ); end(); } : undefined;
    const menu = ( e : React.MouseEvent ) => { if (p.onMenu) { e.preventDefault(); p.onMenu( { x : e.clientX, y : e.clientY } ); } };

    const label = <span className={"nf-label nodrag" + (isExpr ? "" : " scrub")} onPointerDown={onLabelDown} onPointerMove={onLabelMove} onPointerUp={onLabelUp}
        onPointerCancel={onLabelUp} onDoubleClick={reset} onContextMenu={menu}
        title={isExpr ? p.label : `${p.label}: drag to change (Shift ×10, Alt ÷10)${reset ? `, double-click to reset to ${format( p.defaultValue!, p.range.step )}${unit}` : ""}`}>{p.label}</span>;
    const field = <span className={"nf-value" + (holding ? " holding" : "") + (out ? " out" : "")} style={p.compact && !isExpr ? { "--nf-frac" : frac } as React.CSSProperties : undefined} title={title}>
        {isExpr && <span className="nf-fx" aria-hidden="true">ƒ</span>}
        <input className="nodrag" id={p.id} value={text} role={isExpr ? undefined : "spinbutton"}
            aria-label={p.label + (isExpr ? " expression" : "")} aria-valuenow={isFinite( num ) ? num : undefined}
            aria-valuetext={isExpr ? `${p.value}, equals ${p.computed != null ? format( p.computed, p.range.step ) : "unknown"}${unit}` : `${format( num, p.range.step )}${unit}`}
            onFocus={() => setEditing( true )} onChange={e => setText( e.target.value )} onBlur={commitText} onKeyDown={onKey} onContextMenu={menu} />
        {isExpr && p.computed != null && <span className="nf-computed">→ {format( p.computed, p.range.step )}</span>}
    </span>;

    if (p.compact) return <span className="nf compact">{label}{field}{p.unit && <span className="nf-unit">{p.unit}</span>}</span>;
    return <span className="nf full">
        <span className="nf-line">
            {label}
            {!isExpr && <button type="button" className="nf-step nodrag" tabIndex={-1} aria-label={"Decrease " + p.label} onPointerDown={onStepDown( -1 )} onPointerUp={onStepUp} onPointerLeave={onStepUp}>−</button>}
            {!isExpr && <span className="nf-slider">
                <input type="range" className="nodrag" aria-label={p.label} min={lo} max={hi} step={p.range.step} value={isFinite( num ) ? num : lo}
                    onPointerDown={begin} onInput={e => preview( +(e.target as HTMLInputElement).value )} onPointerUp={() => end()}
                    onKeyUp={() => { if (keyTimer.current != null) clearTimeout( keyTimer.current ); keyTimer.current = window.setTimeout( () => end(), KEY_PAUSE ); }}
                    onKeyDown={e => { if (/Arrow|Page|Home|End/.test( e.key )) begin(); }} aria-valuetext={`${format( num, p.range.step )}${unit}`} />
                {(p.presets ?? []).map( q => q.value >= lo && q.value <= hi &&
                    <span key={q.label} className="nf-tick" style={{ left : `calc(${(q.value - lo) / (hi - lo)} * (100% - 14px) + 7px)` }} aria-hidden="true" /> )}
            </span>}
            {!isExpr && <button type="button" className="nf-step nodrag" tabIndex={-1} aria-label={"Increase " + p.label} onPointerDown={onStepDown( 1 )} onPointerUp={onStepUp} onPointerLeave={onStepUp}>+</button>}
            {field}
            {p.unit && <span className="nf-unit">{p.unit}</span>}
            {p.onLocate && <button type="button" className="nf-locate nodrag" aria-label={"Show " + p.label + " in the graph"} title="Show in the graph" onClick={p.onLocate}>⌖</button>}
            {p.onMenu && <button type="button" className="nf-menu nodrag" aria-label={p.label + " settings"} title="Range, step, presets"
                onClick={e => { const r = (e.target as HTMLElement).getBoundingClientRect(); p.onMenu!( { x : r.left, y : r.bottom } ); }}>⋯</button>}
        </span>
        {p.presets && p.presets.length > 0 && !isExpr && <span className="nf-presets" role="group" aria-label={p.label + " presets"}>
            {p.presets.slice( 0, 4 ).map( q => <button type="button" key={q.label} className="nodrag" aria-pressed={Math.abs( num - q.value ) < p.range.step / 2}
                onClick={() => { begin(); preview( q.value ); end(); }}>{q.label}</button> )}
        </span>}
    </span>;
}

/** A switch for a 0/1 parameter. Space or Enter toggles; a commit each time. */
export function ToggleField( p : { label : string, value : number, onCommit( v : number, key : string ) : void, id? : string } ) {
    const on = p.value != 0;
    return <span className="nf toggle">
        <span className="nf-label">{p.label}</span>
        <button type="button" role="switch" aria-checked={on} aria-label={p.label} id={p.id} className="nf-switch nodrag"
            onClick={() => p.onCommit( on ? 0 : 1, p.id ?? p.label )}><span /></button>
    </span>;
}

/** One of a few named values: segmented buttons (up to `segments`, 3 in a node), a select beyond. */
export function ChoiceField( p : { label : string, value : number, options : Array<{ label : string, value : number }>, segments? : number,
    onCommit( v : number, key : string ) : void, id? : string } ) {
    const max = p.segments ?? 5;
    if (p.options.length > max) return <span className="nf choice">
        <span className="nf-label">{p.label}</span>
        <select className="nodrag" aria-label={p.label} id={p.id} value={p.value} onChange={e => p.onCommit( +e.target.value, p.id ?? p.label )}>
            {p.options.map( o => <option key={o.label} value={o.value}>{o.label}</option> )}
            {!p.options.some( o => o.value == p.value ) && <option value={p.value}>{p.value}</option>}
        </select>
    </span>;
    return <span className="nf choice">
        <span className="nf-label">{p.label}</span>
        <span className="nf-segments" role="radiogroup" aria-label={p.label} id={p.id}
            onKeyDown={e => {
                const i = p.options.findIndex( o => o.value == p.value );
                const j = e.key == "ArrowRight" || e.key == "ArrowDown" ? i + 1 : e.key == "ArrowLeft" || e.key == "ArrowUp" ? i - 1 : null;
                if (j == null) return;
                e.preventDefault();
                const o = p.options[(j + p.options.length) % p.options.length];
                p.onCommit( o.value, p.id ?? p.label );
            }}>
            {p.options.map( o => <button type="button" key={o.label} role="radio" aria-checked={o.value == p.value} tabIndex={o.value == p.value ? 0 : -1}
                className="nodrag" onClick={() => p.onCommit( o.value, p.id ?? p.label )}>{o.label}</button> )}
        </span>
    </span>;
}

export { stepFor };
