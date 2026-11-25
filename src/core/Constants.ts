// `Constants` contains a collection of default constants used throughout the library. These can be set to adjust verb's
// defaults.

export class Constants {
    //The default euclidean distance that identifies whether two points are coincident
    public static TOLERANCE : number = 1e-6;
    
    //The minimum value to determine whether two floating point numbers are the same
    public static EPSILON : number = 1e-10;

    //The current version of verb
    public static VERSION : string = "3.0.3";
}
