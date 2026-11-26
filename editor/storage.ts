// Keeping and sharing graph documents from the editor, with what the browser offers and nothing on a server:
//
// * a link that holds the whole document: deflated, base64url-encoded, after "#g=" (the fragment never leaves the
//   browser, so a shared link sends the graph to no server);
// * an autosave in localStorage, restored on the next visit (per browser, and it may be cleared: the file is the copy
//   that lasts);
// * files: the File System Access API where there is one (Save writes back to the same file), a download otherwise.
//
// `encode` and `decode` use CompressionStream, which Node has too, so the tests run them.

/** The fragment key of a shared document: `#g=<base64url of the deflated JSON>`. */
export const LINK_KEY = "g";
/** Where the autosave lives in localStorage. */
export const AUTOSAVE_KEY = "verb-nurbs-ts/editor/document";

const b64url = ( bytes : Uint8Array ) : string => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode( ...bytes.subarray( i, i + 0x8000 ) );
    return btoa( s ).replace( /\+/g, "-" ).replace( /\//g, "_" ).replace( /=+$/, "" );
};
const unb64url = ( text : string ) : Uint8Array => {
    const s = atob( text.replace( /-/g, "+" ).replace( /_/g, "/" ) + "===".slice( (text.length + 3) % 4 ) );
    const out = new Uint8Array( s.length );
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt( i );
    return out;
};
const pipe = async ( bytes : Uint8Array, stream : CompressionStream | DecompressionStream ) : Promise<Uint8Array> =>
    new Uint8Array( await new Response( new Blob( [bytes as BlobPart] ).stream().pipeThrough( stream ) ).arrayBuffer() );

/** A document as the text of a link fragment. */
export async function encode( doc : unknown ) : Promise<string> {
    return b64url( await pipe( new TextEncoder().encode( JSON.stringify( doc ) ), new CompressionStream( "deflate-raw" ) ) );
}

/** The document a link fragment holds; throws when the text is not one. */
export async function decode( text : string ) : Promise<unknown> {
    return JSON.parse( new TextDecoder().decode( await pipe( unb64url( text ), new DecompressionStream( "deflate-raw" ) ) ) );
}

/** The document in a URL's fragment (`#g=...`), or null when it has none. */
export async function fromLink( hash : string ) : Promise<unknown> {
    const m = new RegExp( `[#&]${LINK_KEY}=([A-Za-z0-9_-]+)` ).exec( hash );
    return m == null ? null : decode( m[1] );
}

/** The last autosaved document, or null (none, or storage unavailable). */
export function restore() : unknown {
    try { const t = localStorage.getItem( AUTOSAVE_KEY ); return t == null ? null : JSON.parse( t ); } catch { return null; }
}

/** Autosaves a document; storage that is full or blocked is ignored (the file is the copy that lasts). */
export function autosave( doc : unknown ) : void {
    try { localStorage.setItem( AUTOSAVE_KEY, JSON.stringify( doc ) ); } catch { /* private mode, quota: nothing to do */ }
}

// ------------------------------------------------------------ files
interface Handle { name : string; createWritable() : Promise<{ write( d : Blob ) : Promise<void>; close() : Promise<void> }>; getFile() : Promise<File> }
type Picker = ( options : object ) => Promise<Handle | Array<Handle>>;
const picker = ( name : "showSaveFilePicker" | "showOpenFilePicker" ) : Picker | null => {
    const f = (globalThis as unknown as Record<string, unknown>)[name];
    return typeof f == "function" ? (f as Picker).bind( globalThis ) : null;
};
const JSON_TYPES = [{ description : "Graph document", accept : { "application/json" : [".json"] } }];
let saved : Handle | null = null;

/** Saves text as a file: to the file it was opened from or last saved to, else a chosen one, else a download. */
export async function saveFile( text : string, suggested : string, type = "application/json", again = true ) : Promise<string> {
    const blob = new Blob( [text], { type } );
    const pick = picker( "showSaveFilePicker" );
    if (pick != null) {
        try {
            const h = again && saved != null && type == "application/json" ? saved
                : await pick( { suggestedName : suggested, types : type == "application/json" ? JSON_TYPES : undefined } ) as Handle;
            const w = await h.createWritable(); await w.write( blob ); await w.close();
            if (type == "application/json") saved = h;
            return h.name;
        } catch (e) { if ((e as Error).name == "AbortError") return ""; }
    }
    download( blob, suggested );
    return suggested;
}

/** A binary file (an STL) as a download: print files go where slicers look, and several can follow one click. */
export async function saveBinary( data : ArrayBuffer, suggested : string, type : string ) : Promise<string> {
    download( new Blob( [data], { type } ), suggested );
    return suggested;
}

/** Opens a document file: with the open dialog where there is one (and remembers it for Save), else `fallback()`. */
export async function openFile( fallback : () => void ) : Promise<{ name : string, text : string } | null> {
    const pick = picker( "showOpenFilePicker" );
    if (pick == null) { fallback(); return null; }
    try {
        const [h] = await pick( { types : JSON_TYPES, multiple : false } ) as Array<Handle>;
        saved = h;
        const f = await h.getFile();
        return { name : f.name, text : await f.text() };
    } catch { return null; }
}

/** Forgets the file Save writes to (a new document was opened another way). */
export function forgetFile() : void { saved = null; }

function download( blob : Blob, name : string ) : void {
    const a = document.createElement( "a" );
    a.href = URL.createObjectURL( blob );
    a.download = name;
    a.click();
    setTimeout( () => URL.revokeObjectURL( a.href ), 10000 );
}
