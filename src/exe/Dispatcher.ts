// Runs a static method and returns its result as a `Promise`.
//
// Upstream verb dispatched `_Async` methods to a pool of web workers. The TypeScript port keeps the `_Async` API but
// runs the work on the calling thread in a microtask, which keeps the library free of worker and bundler setup.
// A worker-backed dispatcher can be plugged in later without changing callers.

export class Dispatcher {
    public static THREADS: number = 1;

    public static dispatchMethod<T>(classType: any, methodName: string, args: Array<any>): Promise<T | any> {
        return new Promise<T>((resolve, reject) => {
            try {
                resolve(classType[methodName].apply(classType, args));
            } catch (e) {
                reject(e);
            }
        });
    }
}
