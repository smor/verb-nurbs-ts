import { ArrayExtensions } from "./ArrayExtensions.js";
import { Constants } from "./Constants.js";
import { Point, Vector } from "./Data.js";

// Tools for working with vectors

export class Vec {

    public static angleBetween(a : Array<number>, b : Array<number>) : number{
        return Math.acos( Vec.dot(a, b) / ( Vec.norm(a) * Vec.norm(b) )  );
    }

    public static positiveAngleBetween(a : Array<number>, b : Array<number>, n : Array<number>) : number{
        const nab = Vec.cross(a,b);

        const al = Vec.norm(a);
        const bl = Vec.norm(b);
        const abl = al * bl;
        const adb = Vec.dot(a,b);

        const sina = Vec.norm(nab) / abl;
        const cosa = adb / abl;

        const w = Math.atan2( sina, cosa );
        const s = Vec.dot(n, nab);

        if (Math.abs(s) < Constants.EPSILON) return w;

        return s > 0 ? w : -w;
    }

    public static signedAngleBetween(a : Array<number>, b : Array<number>, n : Array<number>) : number{
        const nab = Vec.cross(a,b);

        const al = Vec.norm(a);
        const bl = Vec.norm(b);
        const abl = al * bl;
        const adb = Vec.dot(a,b);

        const sina = Vec.norm(nab) / abl;
        const cosa = adb / abl;

        const w = Math.atan2( sina, cosa );
        const s = Vec.dot(n, nab);

        return s > 0.0 ? w : 2 * Math.PI - w;
    }

    public static angleBetweenNormalized2d(a : Array<number>, b : Array<number>) : number {
        const perpDot = a[0] * b[1]-a[1] * b[0];
        return Math.atan2(perpDot, Vec.dot(a, b));
    }

    public static domain(a : Array<number>) : number {
        return ArrayExtensions.last(a) - ArrayExtensions.first(a);
    }

    public static range(max : number) : Array<number> {
        const l = [];
        let f = 0.0;
        for (let i = 0; i < max; i++) {
            l.push(f);
            f += 1.0;
        }
        return l;
    }

    public static span(min : number, max : number, step : number) : Array<number> {
            if (step == null) return [];
        if (step < Constants.EPSILON) return []; //infinite
        if (min > max && step > 0.0) return []; //infinite
        if (max > min && step < 0.0) return []; //infinite

        const l = [];
        let cur = min;

        while( cur <= max ){
            l.push(cur);
            cur += step;
        }

        return l;
    }

    public static neg(arr : Array<number>) : Array<number> {
        return arr.map(function(x){ return -x; });
    }

    public static min(arr : Array<number>) : number {
        return arr.reduce(function(a, x){ return Math.min(x,a); }, Infinity);
    }

    public static max(arr : Array<number>) : number {
        return arr.reduce(function(a, x){ return Math.max(x,a); }, -Infinity);
    }

    public static all(arr : Array<boolean>) : boolean {
        return arr.reduce(function(a, x){ return a && x; }, true);
    }

    public static finite(arr : Array<number>) : Array<boolean> {
        return arr.map(function(x){ return Number.isFinite(x); });
    }

    public static onRay(origin : Point, dir : Vector, u : number) : Array<number> {
        return Vec.add( origin, Vec.mul(u, dir) );
    }

    public static lerp(i : number, u : Array<number>, v : Array<number>) : Array<number>{
        return Vec.add( Vec.mul( i, u ), Vec.mul( 1.0 - i, v) );
    }

    public static normalized( arr : Array<number> ){
        return Vec.div( arr, Vec.norm(arr) );
    }

    public static cross(u : Array<number>, v : Array<number>) : Array<number>{
        return [u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    }

    public static dist(a : Array<number>, b : Array<number> ) : number {
        return Vec.norm(Vec.sub(a,b));
    }

    public static distSquared(a : Array<number>, b : Array<number> ) : number {
        return Vec.normSquared(Vec.sub(a,b));
    }

    public static sum(a : Array<number>) : number {
        return a.reduce(function(a, x){ return a + x; }, 0);
    }

    public static addAll(a : Array<Array<number>>) : Array<number> | null {
        if (a.length == 0) return null;

        const f = a[0].length;

        return a.reduce(function(a, x){ return Vec.add(a,x); }, Vec.rep(f, 0.0));
    }

    public static addAllMutate(a : Array<Array<number>>) {
        const f = a[0];
        for (let i = 1; i < a.length; i++) 
            Vec.addMutate(f, a[i]);
    }

    public static addMulMutate(a : Array<number>, s : number, b : Array<number>) {
        for (let i = 0; i < a.length; i++) 
            a[i] = a[i] + s * b[i];
    }

    public static subMulMutate(a : Array<number>, s : number, b : Array<number>) {
        for (let i = 0; i < a.length; i++) 
            a[i] = a[i] - s * b[i];
    }

    public static addMutate(a : Array<number>, b : Array<number>) {
        for (let i = 0; i < a.length; i++) 
            a[i] = a[i] + b[i];
    }

    public static subMutate(a : Array<number>, b : Array<number>) {
        for (let i = 0; i < a.length; i++) 
            a[i] = a[i] - b[i];
    }

    public static mulMutate(a : number, b : Array<number>) {
        for (let i = 0; i < b.length; i++) 
            b[i] = b[i] * a;
    }

    public static norm(a : Array<number> ) : number {
        const norm2 = Vec.normSquared(a);
        return norm2 != 0.0 ? Math.sqrt( norm2 ) : norm2;
    }

    public static normSquared(a : Array<number> ) : number {
        return a.reduce(function(a, x){ return a + x * x; }, 0);
    }

    public static rep<T>(num : number, ele : T ) : Array<T> {
        const r = new Array( num ); for (let i = 0; i < num; i++) r[i] = ele; return r;
    }

    public static zeros1d(rows : number) : Array<number> {
        const r = new Array<number>( rows ); for (let i = 0; i < rows; i++) r[i] = 0.0; return r;
    }

    public static zeros2d(rows : number, cols : number) : Array<Array<number>> {
        const r = new Array( rows ); for (let i = 0; i < rows; i++) r[i] = Vec.zeros1d( cols ); return r;
    }

    public static zeros3d(rows : number, cols : number, depth : number) : Array<Array<Array<number>>> {
        const r = new Array( rows ); for (let i = 0; i < rows; i++) r[i] = Vec.zeros2d( cols, depth ); return r;
    }

    public static dot(a : Array<number>, b : Array<number>) : number {
        let sum : number = 0;
        for (let i = 0; i < a.length; i++) {
            sum += a[i] * b[i];
        }
        return sum;
    }

    public static add(a : Array<number>, b : Array<number>) : Array<number>{
        const n = a.length, r = new Array<number>( n ); for (let i = 0; i < n; i++) r[i] = a[i] + b[i]; return r;
    }

    public static mul(a : number, b : Array<number>) : Array<number>{
        const n = b.length, r = new Array<number>( n ); for (let i = 0; i < n; i++) r[i] = a * b[i]; return r;
    }

    public static div(a : Array<number>, b : number ) : Array<number>{
        const n = a.length, r = new Array<number>( n ); for (let i = 0; i < n; i++) r[i] = a[i] / b; return r;
    }

    public static sub(a : Array<number>, b : Array<number>) : Array<number>{
        const n = a.length, r = new Array<number>( n ); for (let i = 0; i < n; i++) r[i] = a[i] - b[i]; return r;
    }

    public static isZero( vec : Array<number> ){

        for (let i = 0; i < vec.length; i++) {
            if (Math.abs( vec[i] ) > Constants.TOLERANCE ) return false;
        }

        return true;
    }

    public static sortedSetUnion( a : Array<number>, b : Array<number>) : Array<number> {

        const merged = [];

        let ai = 0;
        let bi = 0;
        while ( ai < a.length || bi < b.length ){

            if ( ai >= a.length ){
                merged.push( b[bi] );
                bi++;
                continue;
            } else if ( bi >= b.length ){
                merged.push( a[ai] );
                ai++;
                continue;
            }

            const diff = a[ai] - b[bi];

            if ( Math.abs(diff) < Constants.EPSILON ){
                merged.push( a[ai] );
                ai++;
                bi++;
                continue;
            }

            if (diff > 0.0){
                //add the smaller
                merged.push( b[bi] );
                bi++;
                continue;
            }

            //thus diff < 0.0
            merged.push( a[ai] );
            ai++;

        }

        return merged;
    }

    //a is superset, hence it is always longer or equal
    public static sortedSetSub( a : Array<number>, b : Array<number>) : Array<number> {

        const result = [];

        let ai = 0;
        let bi = 0;
        while ( ai < a.length ){

            if ( bi >= b.length ){
                result.push( a[ai] );
                ai++;
                continue;
            }

            if ( Math.abs( a[ai] - b[bi] ) < Constants.EPSILON ){
                ai++;
                bi++;
                continue;
            }

            result.push( a[ai] );
            ai++;
        }

        return result;
    }
}
