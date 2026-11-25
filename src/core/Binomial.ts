export class Binomial {

    static memo = new Map<number, Map<number, number>>();

    public static get(n : number, k : number) : number {
        if (k == 0.0) {
            return 1.0;
        }

        if (n == 0 || k > n) {
            return 0.0;
        }

        if (k > n - k) {
            k = n - k;
        }

        if ( Binomial.memo_exists(n,k) ) {
            return Binomial.get_memo(n,k);
        }

        let r : number = 1;
        const n_o = n;

        for (let d = 1; d < k+1; d++) {

            if ( Binomial.memo_exists(n_o, d) ) {
                n--;
                r = Binomial.get_memo(n_o, d);
                continue;
            }

            r *= n--;
            r /= d;

            Binomial.memoize(n_o, d, r);

        }

        return r;
    }

    public static get_no_memo(n : number, k : number) : number {
        if (k == 0) {
            return 1;
        }

        if (n == 0 || k > n) {
            return 0;
        }

        if (k > n - k) {
            k = n - k;
        }

        let r : number = 1;

        for (let d = 1; d < k+1; d++) {
            r *= n--;
            r /= d;
        }

        return r;
    }

    private static memo_exists(n : number, k : number) : boolean {
        return ( Binomial.memo.has(n) && Binomial.memo.get(n)!.has(k) );
    }

    private static get_memo(n : number, k : number) : number {
        return Binomial.memo.get(n)!.get(k)!;
    }

    private static memoize(n : number, k : number, val : number) {
        if ( !Binomial.memo.has(n) ) {
            Binomial.memo.set( n, new Map<number, number>() );
        }

        Binomial.memo.get( n )!.set( k, val );
    }
}