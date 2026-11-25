// Serialization for verb objects.
//
// Upstream verb used Haxe's serializer. The TypeScript port serializes to JSON instead. Class instances are tagged
// with a `$type` field so that `Deserializer.deserialize` can rebuild them with their prototype.

// any constructor: the registry rebuilds instances of classes with different constructor signatures
type Constructor = abstract new (...args: never[]) => unknown;

const registry = new Map<string, Constructor>();

// Register a class so that it can be rebuilt by `Deserializer.deserialize`.
export function registerSerializable(name: string, ctor: Constructor): void {
    registry.set(name, ctor);
    (ctor as any).__verbTypeName = name;
}

function encode(value: any): any {
    if (value === null || value === undefined || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(encode);
    const out: any = {};
    const name = (value.constructor as any)?.__verbTypeName;
    if (name) out.$type = name;
    for (const k of Object.keys(value)) out[k] = encode(value[k]);
    return out;
}

function decode(value: any): any {
    if (value === null || value === undefined || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(decode);
    let out: any = {};
    if (value.$type) {
        const ctor = registry.get(value.$type);
        if (!ctor) throw new Error("Unknown serialized type: " + value.$type);
        out = Object.create(ctor.prototype);
    }
    for (const k of Object.keys(value)) if (k !== "$type") out[k] = decode(value[k]);
    return out;
}

export interface ISerializable {
    serialize(): string;
}

export class SerializableBase implements ISerializable {
    public serialize(): string {
        return JSON.stringify(encode(this));
    }
}

export class Deserializer {
    public static deserialize<T>(s: string): T {
        return decode(JSON.parse(s)) as T;
    }
}
