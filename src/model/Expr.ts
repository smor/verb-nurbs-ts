// Parameter expressions: arithmetic over named parameters, evaluated without `eval`, the same way on every machine.
//
//     width / 2 + wall          max(r1, r2) * 1.5          sqrt(a^2 + b^2)          -pi / 4
//
// Grammar (precedence low to high): sum := product (("+" | "-") product)*; product := unary (("*" | "/" | "%")
// unary)*; unary := "-" unary | power; power := atom ("^" unary)?; atom := number | name | name "(" args ")" |
// "(" sum ")". `^` is right-associative and binds tighter than unary minus on its left (-2^2 is -4), as in
// mathematics. Names are parameters, or the constants pi and e. Functions: sin, cos, tan (radians), asin, acos,
// atan, atan2, sqrt, abs, min, max, pow, floor, ceil, round, exp, log, sign, clamp(x, lo, hi), lerp(a, b, t),
// rad(degrees), deg(radians).
//
// Only finite numbers come out: a division by zero or a square root of a negative is an error naming the
// expression, never a NaN that surfaces three features later.

type Token = { kind : "num", value : number, at : number } | { kind : "name", value : string, at : number } | { kind : "op", value : string, at : number };

const FUNCTIONS : { [name : string] : { arity : [number, number], f : (...x : Array<number>) => number } } = {
    sin : { arity : [1, 1], f : Math.sin }, cos : { arity : [1, 1], f : Math.cos }, tan : { arity : [1, 1], f : Math.tan },
    asin : { arity : [1, 1], f : Math.asin }, acos : { arity : [1, 1], f : Math.acos }, atan : { arity : [1, 1], f : Math.atan },
    atan2 : { arity : [2, 2], f : Math.atan2 }, sqrt : { arity : [1, 1], f : Math.sqrt }, abs : { arity : [1, 1], f : Math.abs },
    min : { arity : [1, Infinity], f : Math.min }, max : { arity : [1, Infinity], f : Math.max }, pow : { arity : [2, 2], f : Math.pow },
    floor : { arity : [1, 1], f : Math.floor }, ceil : { arity : [1, 1], f : Math.ceil }, round : { arity : [1, 1], f : Math.round },
    exp : { arity : [1, 1], f : Math.exp }, log : { arity : [1, 1], f : Math.log }, sign : { arity : [1, 1], f : Math.sign },
    clamp : { arity : [3, 3], f : (x, lo, hi) => Math.max( lo, Math.min( hi, x ) ) },
    lerp : { arity : [3, 3], f : (a, b, t) => a + (b - a) * t },
    rad : { arity : [1, 1], f : (d) => d * Math.PI / 180 }, deg : { arity : [1, 1], f : (r) => r * 180 / Math.PI },
};
const CONSTANTS : { [name : string] : number } = { pi : Math.PI, e : Math.E };

export class Expr {

    // The value of an expression, with the parameters' values.
    public static evaluate( text : string, scope : { [name : string] : number } ) : number {
        const tokens = Expr.tokens( text );
        let i = 0;
        const fail = (msg : string, at? : number) : never => {
            throw new Error( `Expression "${text}": ${msg}` + (at != null ? ` (at character ${at + 1})` : "") );
        };
        const peek = () => tokens[i];
        const isOp = (v : string) => { const t = tokens[i]; return t != null && t.kind == "op" && t.value == v; };
        const expect = (v : string) => { if (!isOp( v )) fail( `expected "${v}"`, peek() != null ? peek().at : text.length ); i++; };
        const finite = (x : number, what : string, at : number) => { if (!isFinite( x )) fail( what + " is not a finite number", at ); return x; };

        const sum = () : number => {
            let x = product();
            while (isOp( "+" ) || isOp( "-" )) {
                const op = tokens[i++].value, y = product();
                x = op == "+" ? x + y : x - y;
            }
            return x;
        };
        const product = () : number => {
            let x = unary();
            while (isOp( "*" ) || isOp( "/" ) || isOp( "%" )) {
                const t = tokens[i++], y = unary();
                if (t.value != "*" && y == 0) fail( "division by zero", t.at );
                x = t.value == "*" ? x * y : t.value == "/" ? x / y : x % y;
            }
            return x;
        };
        const unary = () : number => {
            if (isOp( "-" )) { i++; return -unary(); }
            if (isOp( "+" )) { i++; return unary(); }
            return power();
        };
        const power = () : number => {
            const at = peek() != null ? peek().at : text.length;
            const x = atom();
            if (isOp( "^" )) { i++; return finite( Math.pow( x, unary() ), "the power", at ); }
            return x;
        };
        const atom = () : number => {
            const t = peek();
            if (t == null) return fail( "unexpected end" );
            if (t.kind == "num") { i++; return t.value; }
            if (isOp( "(" )) { i++; const x = sum(); expect( ")" ); return x; }
            if (t.kind == "name") {
                i++;
                if (isOp( "(" )) {
                    const fn = FUNCTIONS[t.value];
                    if (fn == null) return fail( `unknown function "${t.value}"`, t.at );
                    i++;
                    const args : Array<number> = [];
                    if (!isOp( ")" )) { args.push( sum() ); while (isOp( "," )) { i++; args.push( sum() ); } }
                    expect( ")" );
                    if (args.length < fn.arity[0] || args.length > fn.arity[1]) fail( `${t.value} takes ${fn.arity[0] == fn.arity[1] ? fn.arity[0] : fn.arity[0] + " or more"} argument(s)`, t.at );
                    return finite( fn.f( ...args ), t.value + "(...)", t.at );
                }
                if (Object.prototype.hasOwnProperty.call( scope, t.value )) return scope[t.value];
                if (Object.prototype.hasOwnProperty.call( CONSTANTS, t.value )) return CONSTANTS[t.value];
                return fail( `unknown name "${t.value}"`, t.at );
            }
            return fail( `unexpected "${t.value}"`, t.at );
        };
        const x = sum();
        if (i < tokens.length) fail( `unexpected "${tokens[i].value}"`, tokens[i].at );
        return finite( x, "the result", 0 );
    }

    // The parameter names an expression uses (not functions or constants), in order of first use.
    public static names( text : string ) : Array<string> {
        const tokens = Expr.tokens( text ), out : Array<string> = [];
        tokens.forEach( (t, k) => {
            const call = tokens[k + 1] != null && tokens[k + 1].kind == "op" && tokens[k + 1].value == "(";
            if (t.kind == "name" && !call && !Object.prototype.hasOwnProperty.call( CONSTANTS, t.value ) && !out.includes( t.value )) out.push( t.value );
        } );
        return out;
    }

    private static tokens( text : string ) : Array<Token> {
        const out : Array<Token> = [];
        let i = 0;
        while (i < text.length) {
            const c = text[i];
            if (/\s/.test( c )) { i++; continue; }
            const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec( text.slice( i ) );
            if (num != null) { out.push( { kind : "num", value : parseFloat( num[0] ), at : i } ); i += num[0].length; continue; }
            const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec( text.slice( i ) );
            if (name != null) { out.push( { kind : "name", value : name[0], at : i } ); i += name[0].length; continue; }
            if ("+-*/%^(),".includes( c )) { out.push( { kind : "op", value : c, at : i } ); i++; continue; }
            throw new Error( `Expression "${text}": unexpected character "${c}" (at character ${i + 1})` );
        }
        return out;
    }
}
