import { Matrix, Vector } from "./Data.js";
import { Vec } from "./Vec.js";

// Tools for working with matrices

export class Mat {

    // Multiply a `Matrix` by a constant

    public static mul(a : number, b : Matrix ) : Matrix {
        return Array.from({ length: b.length }, (_, i) => Vec.mul(a, b[i]));
    }

    // Multiply two matrices assuming they are of compatible dimensions.
    //
    // Based on the numeric.js routine - `numeric.dotMMsmall`

    public static mult(x : Matrix, y : Matrix) : Matrix {

        let p,q,r,ret,foo,bar,woo,i0,k0,p0,r0;

        p = x.length; q = y.length; r = y[0].length;
        ret = [];

        let i = p-1;
        let j = 0;
        let k = 0;

        while (i>=0){
            foo = [];
            bar = x[i];

            k = r-1;
            while( k >= 0 ){
                woo = bar[q-1]*y[q-1][k];

                j = q-2;
                while ( j >= 1 ){
                    i0 = j-1;
                    woo += bar[j]*y[j][k] + bar[i0]*y[i0][k];
                    j -= 2;
                }
                if(j==0) { woo += bar[0]*y[0][k]; }
                foo[k] = woo;
                k--;
            }
            ret[i] = foo;
            i--;
        }
        return ret;
    }

    // Add two matrices

    public static add(a : Matrix, b : Matrix ) : Matrix {
        return Array.from({ length: a.length }, (_, i) => Vec.add(a[i], b[i]));
    }

    // Divide each of entry of a Matrix by a constant

    public static div(a : Matrix, b : number ) : Matrix {
        return Array.from({ length: a.length }, (_, i) => Vec.div(a[i], b));
    }

    // Subtract two matrices

    public static sub(a : Matrix, b : Matrix ) : Matrix {
        return Array.from({ length: a.length }, (_, i) => Vec.sub(a[i], b[i]));
    }

    // Multiply a `Matrix` by a `Vector`

    public static dot(a : Matrix, b : Vector ) : Vector {
        return Array.from({ length: a.length }, (_, i) => Vec.dot(a[i], b));
    }

    // Build an identity matrix of a given size

    public static identity(n : number) : Matrix {
        let zeros = Vec.zeros2d(n, n);
        for (let i = 0; i < n; i++) { zeros[i][i] = 1.0; }
        return zeros;
    }

    // Transpose a matrix

    public static transpose<T>(a : Array<Array<T>>) : Array<Array<T>> {
        if (a.length == 0) return [];
        return Array.from({ length: a[0].length }, (_, i) => Array.from({ length: a.length }, (_, j) => a[j][i]));
    }

    // Solve a system of equations

    public static solve(A : Matrix, b : Vector) : Vector {
        return Mat.LUsolve( Mat.LU(A), b );
    }

    // Based on methods from numeric.js

    private static LUsolve(LUP : LUDecomp, b : Vector) : Vector {
        let i, j;
        let LU = LUP.LU;
        let n   = LU.length;
        let x = b.slice();
        let P   = LUP.P;
        let Pi, LUi, LUii, tmp;

        i = n-1;
        while ( i != -1 ){
            x[i] = b[i];
            --i;
        }

        i = 0;
        while (i < n){
            Pi = P[i];
            if (P[i] != i) {
                tmp = x[i];
                x[i] = x[Pi];
                x[Pi] = tmp;
            }

            LUi = LU[i];
            j = 0;
            while (j < i){
                x[i] -= x[j] * LUi[j];
                ++j;
            }
            ++i;
        }

        i = n-1;
        while (i >= 0){
            LUi = LU[i];
            j = i+1;
            while (j < n){
                x[i] -= x[j] * LUi[j];
                ++j;
            }

            x[i] /= LUi[i];
            --i;
        }

        return x;
    }

    // Based on methods from numeric.js

    private static LU( A : Matrix ) : LUDecomp {

        let abs = Math.abs;
        let i, j, k, absAjk, Akk, Ak, Pk, Ai;
        let max;
        //copy A
        A = Array.from({ length: A.length }, (_, i) => A[i].slice());
        let n = A.length, n1 = n-1;
        let P = new Array<number>(); //new Array(n);

        k = 0;
        while (k < n){
            Pk = k;
            Ak = A[k];
            max = Math.abs(Ak[k]);

            j = k+1;
            while (j < n){
                absAjk = Math.abs(A[j][k]);
                if (max < absAjk) {
                    max = absAjk;
                    Pk = j;
                }
                ++j;
            }
            P[k] = Pk;

            if (Pk != k) {
                A[k] = A[Pk];
                A[Pk] = Ak;
                Ak = A[k];
            }

            Akk = Ak[k];

            i = k+1;
            while (i < n){
                A[i][k] /= Akk;
                ++i;
            }

            i = k+1;
            while (i < n){
                Ai = A[i];
                j = k+1;
                while (j < n1){
                    Ai[j] -= Ai[k] * Ak[j];
                    ++j;
                    Ai[j] -= Ai[k] * Ak[j];
                    ++j;
                }
                if(j==n1) Ai[j] -= Ai[k] * Ak[j];
                ++i;
            }

            ++k;
        }

        return new LUDecomp(A, P);
    }

}

// Based on methods from numeric.js

export class LUDecomp {

    public LU : Matrix;
    public P : Array<number>;
    constructor(lu : Matrix, p : Array<number>){
        this.LU = lu;
        this.P = p;
    }

}
