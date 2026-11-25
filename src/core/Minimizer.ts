import { Constants } from "./Constants.js";
import { Matrix, Vector } from "./Data.js";
import { Mat } from "./Mat.js";
import { Vec } from "./Vec.js";

export class Minimizer {

    public static uncmin(f : ((a0: Vector) => number), x0 : Vector, tol : number | null = null, gradient : ((a0: Vector) => Vector) | null = null, maxit : number | null = null) : MinimizationResult {

        if(tol == null) { tol = 1e-8; }
        if(gradient == null) { gradient = function(x) { return Minimizer.numericalGradient(f,x); }; }
        if(maxit == null) maxit = 1000;

        x0 = x0.slice(0);
        const n = x0.length;
        let f0 = f(x0),f1 = f0, df0;

        if(Number.isNaN(f0)) throw 'uncmin: f(x0) is a NaN!';

        tol = Math.max(tol, Constants.EPSILON);
        let step,g0,g1,H1 = Mat.identity(n);
        let it=0,s : any =[],x1,y,Hy,ys,t,nstep;
        let msg = "";
        g0 = gradient( x0 );

        while(it < maxit) {

            if(!Vec.all(Vec.finite(g0))) { msg = "Gradient has Infinity or NaN"; break; }
            step = Vec.neg(Mat.dot(H1,g0));

            if(!Vec.all(Vec.finite(step))) { msg = "Search direction has Infinity or NaN"; break; }

            nstep = Vec.norm(step);
            if(nstep < tol) { msg= "Newton step smaller than tol"; break; }

            t = 1.0;
            df0 = Vec.dot(g0,step);

//line search
            x1 = x0;
            while(it < maxit) {
                if(t*nstep < tol) { break; }
                s = Vec.mul(t, step);
                x1 = Vec.add(x0,s);
                f1 = f(x1);
                if(f1-f0 >= 0.1*t*df0 || Number.isNaN(f1)) {
                    t *= 0.5;
                    ++it;
                    continue;
                }
                break;
            }

            if(t*nstep < tol) { msg = "Line search step size smaller than tol"; break; }
            if(it == maxit) { msg = "maxit reached during line search"; break; }

            g1 = gradient(x1);
            y = Vec.sub(g1,g0);
            ys = Vec.dot(y,s);
            Hy = Mat.dot(H1,y);
            H1 = Mat.sub(
                Mat.add(H1, Mat.mul( (ys+Vec.dot(y,Hy))/(ys*ys),  Minimizer.tensor(s,s)  )),
                Mat.div(Mat.add(Minimizer.tensor(Hy,s),Minimizer.tensor(s,Hy)),ys));
            x0 = x1;
            f0 = f1;
            g0 = g1;
            ++it;
        }

        return new MinimizationResult( x0, f0, g0, H1, it, msg);
    }

    private static numericalGradient(f : ((a0: Vector) => number), x : Vector) : Vector {

        const n = x.length;
        const f0 = f(x);

        if(Number.isNaN(f0)) throw 'gradient: f(x) is a NaN!';

        const x0 = x.slice(0);
        let f1;
        let f2;
        const J = [];

        let errest;
        const eps = 1e-3;
        let t0,t1,t2,it=0,d1,d2,N;

        for (let i = 0; i < n; i++) {

            let h = Math.max(1e-6 * f0, 1e-8);

            while(true) {
                ++it;
                if( it>20 ) { throw "Numerical gradient fails"; }
                x0[i] = x[i]+h;
                f1 = f(x0);
                x0[i] = x[i]-h;
                f2 = f(x0);
                x0[i] = x[i];

                if(Number.isNaN(f1) || Number.isNaN(f2)) { h/=16; continue; }

                J[i] = (f1-f2)/(2*h);
                t0 = x[i]-h;
                t1 = x[i];
                t2 = x[i]+h;
                d1 = (f1-f0)/h;
                d2 = (f0-f2)/h;
                N = Vec.max([ Math.abs(J[i]), Math.abs(f0), Math.abs(f1), Math.abs(f2), Math.abs(t0), Math.abs(t1), Math.abs(t2), 1e-8 ]);

                errest = Math.min( Vec.max([Math.abs(d1-J[i]), Math.abs(d2-J[i]), Math.abs(d1-d2)])/N, h/N);

                if(errest>eps) { h/=16; } else break;
            }
        }

        return J;
    }

    private static tensor(x : Vector, y : Vector) : Matrix {

        const m = x.length;
        const n = y.length;
        const A = [];
        let Ai;
        let xi;

        let i = m-1;
        while (i >= 0){
            Ai = [];
            xi = x[i];
            let j = n-1;
            while(j >= 3){
                Ai[j] = xi * y[j];
                --j;
                Ai[j] = xi * y[j];
                --j;
                Ai[j] = xi * y[j];
                --j;
                Ai[j] = xi * y[j];
                --j;
            }
            while(j>=0) { Ai[j] = xi * y[j]; --j; }
            A[i] = Ai;
            i--;
        }
        return A;
    }

}

export class MinimizationResult {

    public solution : Vector;
    public value : number;
    public gradient : Vector;
    public invHessian : Matrix;
    public iterations : number;
    public message : string;

    constructor(solution : Vector, value : number, gradient : Vector, invHessian : Matrix, iterations : number, message : string){
        this.solution = solution;
        this.value = value;
        this.gradient = gradient;
        this.invHessian = invHessian;
        this.iterations = iterations;
        this.message = message;
    }
}
