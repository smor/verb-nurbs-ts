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

// ------------------------------------------------------------ the claude.ai artifact viewer
// Inside it a page cannot download files itself, and a link's fragment keeps only a plain #name: saves go through
// its "downloads" capability (the viewer confirms each), and links are not offered.
interface Downloads { save( r : { filename : string, data : string | Blob | ArrayBuffer } ) : Promise<{ status : string }> }
type Claude = { use? : ( name : string ) => Promise<unknown> };
const claude = () : Claude | null => (globalThis as unknown as { claude? : Claude }).claude ?? null;
/** Whether the page runs in the claude.ai artifact viewer. */
export const inViewer = () : boolean => typeof claude()?.use == "function";
let downloadsP : Promise<Downloads | null> | null = null;
const downloads = () : Promise<Downloads | null> => downloadsP ??= inViewer()
    ? (claude()!.use!( "downloads" ) as Promise<Downloads | null>).catch( () => null ) : Promise.resolve( null );
const viaViewer = async ( data : string | Blob | ArrayBuffer, name : string ) : Promise<string | null> => {
    const d = await downloads();
    if (d == null) return null;
    try { await d.save( { filename : name, data } ); return name; }
    catch (e) { const code = (e as { code? : string }).code; return code == "declined" ? "" : Promise.reject( new Error( `${name}: ${code ?? e}` ) ); }
};

// ------------------------------------------------------------ zip
// A zip archive of files stored as they are (no compression; STL meshes compress little and slicers open them
// either way): local headers, the data, the central directory. CRC-32 per the zip format (PKWARE APPNOTE 4.4.7).
const CRC = (() => { const t = new Uint32Array( 256 ); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export const crc32 = ( b : Uint8Array ) : number => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
export function zip( files : Array<{ name : string, data : Uint8Array }> ) : ArrayBuffer {
    const enc = new TextEncoder(), parts : Array<Uint8Array> = [], central : Array<Uint8Array> = [];
    let offset = 0;
    for (const f of files) {
        const name = enc.encode( f.name ), crc = crc32( f.data ), n = f.data.length;
        const local = new DataView( new ArrayBuffer( 30 ) );
        local.setUint32( 0, 0x04034b50, true ); local.setUint16( 4, 20, true ); local.setUint16( 6, 0x0800, true );
        local.setUint32( 14, crc, true ); local.setUint32( 18, n, true ); local.setUint32( 22, n, true ); local.setUint16( 26, name.length, true );
        const dir = new DataView( new ArrayBuffer( 46 ) );
        dir.setUint32( 0, 0x02014b50, true ); dir.setUint16( 4, 20, true ); dir.setUint16( 6, 20, true ); dir.setUint16( 8, 0x0800, true );
        dir.setUint32( 16, crc, true ); dir.setUint32( 20, n, true ); dir.setUint32( 24, n, true ); dir.setUint16( 28, name.length, true );
        dir.setUint32( 42, offset, true );
        parts.push( new Uint8Array( local.buffer ), name, f.data );
        central.push( new Uint8Array( dir.buffer ), name );
        offset += 30 + name.length + n;
    }
    const dirSize = central.reduce( ( a, b ) => a + b.length, 0 );
    const end = new DataView( new ArrayBuffer( 22 ) );
    end.setUint32( 0, 0x06054b50, true ); end.setUint16( 8, files.length, true ); end.setUint16( 10, files.length, true );
    end.setUint32( 12, dirSize, true ); end.setUint32( 16, offset, true );
    const all = [...parts, ...central, new Uint8Array( end.buffer )], out = new Uint8Array( offset + dirSize + 22 );
    let at = 0;
    for (const a of all) { out.set( a, at ); at += a.length; }
    return out.buffer;
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
    const viewer = await viaViewer( text, suggested );
    if (viewer != null) return viewer;
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
    const viewer = await viaViewer( data, suggested );
    if (viewer != null) return viewer;
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
    } catch (e) { if ((e as Error).name != "AbortError") fallback(); return null; }
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
