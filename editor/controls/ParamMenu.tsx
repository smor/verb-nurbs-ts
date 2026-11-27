// The settings of one parameter, in a small popover: its soft range, step and unit, its default, its presets, and how
// it shows (a number, a switch, or a choice among named values). Self-contained: React only.
import { useEffect, useRef, useState } from "react";

/** How a parameter shows, kept by the host beside the document (never in what is built). */
export interface ParamMeta {
    min? : number; max? : number; step? : number; unit? : string;
    default? : number;
    kind? : "number" | "toggle" | "choice";
    /** Named values: presets of a number, or the options of a choice. */
    presets? : Array<{ label : string, value : number }>;
    group? : string;
}

const parsePresets = ( t : string ) : Array<{ label : string, value : number }> | null => {
    const out : Array<{ label : string, value : number }> = [];
    for (const part of t.split( "," ).map( s => s.trim() ).filter( Boolean )) {
        const m = /^(.*?)\s*=\s*(-?[\d.]+(?:e-?\d+)?)$/.exec( part );
        if (!m || !m[1] || isNaN( +m[2] )) return null;
        out.push( { label : m[1], value : +m[2] } );
    }
    return out;
};
const printPresets = ( p? : Array<{ label : string, value : number }> ) => (p ?? []).map( q => `${q.label} = ${q.value}` ).join( ", " );

export function ParamMenu( p : { label : string, at : { x : number, y : number }, meta : ParamMeta, effective : { min : number, max : number, step : number },
    current : number, onSave( meta : ParamMeta ) : void, onClose() : void } ) {
    const [min, setMin] = useState( String( p.meta.min ?? p.effective.min ) );
    const [max, setMax] = useState( String( p.meta.max ?? p.effective.max ) );
    const [step, setStep] = useState( String( p.meta.step ?? p.effective.step ) );
    const [unit, setUnit] = useState( p.meta.unit ?? "" );
    const [def, setDef] = useState( p.meta.default != null ? String( p.meta.default ) : "" );
    const [kind, setKind] = useState( p.meta.kind ?? "number" );
    const [presets, setPresets] = useState( printPresets( p.meta.presets ) );
    const box = useRef<HTMLFormElement>( null );
    useEffect( () => {
        box.current?.querySelector( "input" )?.focus();
        const away = ( e : PointerEvent ) => { if (box.current && !box.current.contains( e.target as Node )) p.onClose(); };
        window.addEventListener( "pointerdown", away, true );
        return () => window.removeEventListener( "pointerdown", away, true );
    }, [] );
    const nums = [min, max, step].map( Number );
    const parsed = parsePresets( presets );
    const problem = !nums.every( isFinite ) ? "Min, max and step are numbers"
        : !(nums[1] > nums[0]) ? "Max is above min" : !(nums[2] > 0) ? "The step is above 0"
        : def.trim() != "" && isNaN( +def ) ? "The default is a number" : parsed == null ? "Presets read “Tight = 0.1, Loose = 0.3”"
        : kind == "choice" && parsed.length < 2 ? "A choice needs two options or more" : null;
    const save = ( e : React.FormEvent ) => {
        e.preventDefault();
        if (problem) return;
        p.onSave( { ...p.meta, min : nums[0], max : nums[1], step : nums[2], unit : unit.trim() || undefined,
            default : def.trim() == "" ? undefined : +def, kind : kind == "number" ? undefined : kind, presets : parsed!.length ? parsed! : undefined } );
    };
    // below the button, or above it when it would run off the bottom; always inside the window
    const left = Math.max( 8, Math.min( p.at.x - 250, window.innerWidth - 296 ) );
    const top = p.at.y + 340 < window.innerHeight ? p.at.y + 4 : Math.max( 8, p.at.y - 340 );
    return <form className="param-menu" ref={box} style={{ left, top }} onSubmit={save} onKeyDown={e => { if (e.key == "Escape") { e.stopPropagation(); p.onClose(); } }}
        role="dialog" aria-label={`${p.label} settings`}>
        <strong>{p.label}</strong>
        <label>Show as <select value={kind} onChange={e => setKind( e.target.value as ParamMeta["kind"] & string )}>
            <option value="number">Number</option><option value="toggle">Switch (0 or 1)</option><option value="choice">Choice</option></select></label>
        {kind == "number" && <div className="pm-grid">
            <label>Min <input value={min} onChange={e => setMin( e.target.value )} inputMode="decimal" /></label>
            <label>Max <input value={max} onChange={e => setMax( e.target.value )} inputMode="decimal" /></label>
            <label>Step <input value={step} onChange={e => setStep( e.target.value )} inputMode="decimal" /></label>
            <label>Unit <input value={unit} onChange={e => setUnit( e.target.value )} placeholder="mm" /></label>
        </div>}
        {kind != "toggle" && <label className="pm-wide">{kind == "choice" ? "Options" : "Presets"}
            <input value={presets} onChange={e => setPresets( e.target.value )} placeholder="Tight = 0.1, Normal = 0.17, Loose = 0.3" /></label>}
        {kind == "number" && <label className="pm-wide">Default
            <span className="pm-row"><input value={def} onChange={e => setDef( e.target.value )} placeholder="none" inputMode="decimal" />
                <button type="button" onClick={() => setDef( String( p.current ) )}>Use current ({p.current}{unit ? " " + unit : ""})</button></span></label>}
        {problem && <p className="pm-problem" role="alert">{problem}</p>}
        <span className="pm-actions"><button type="button" onClick={p.onClose}>Cancel</button><button type="submit" disabled={problem != null}>Save</button></span>
    </form>;
}
