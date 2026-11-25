declare module "cdt2d" {
    function cdt2d( points : Array<Array<number>>, edges? : Array<Array<number>>,
                    options? : { delaunay? : boolean, interior? : boolean, exterior? : boolean, infinity? : boolean } ) : Array<Array<number>>;
    export = cdt2d;
}
