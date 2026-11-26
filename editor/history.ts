// Undo and redo for the editor, by document snapshots (docs/visual-programming.md, plan step 4). The graph document is
// the editor's whole state, so a snapshot of it is an undo step: no per-edit inverse to write, and an undone document
// is byte for byte the one that was there before. Pure: no DOM, no React, so the tests run it in Node.

/** How long, in milliseconds, edits that share a coalescing key keep merging into one undo step (a slider drag). */
export const COALESCE_MS = 1000;

/** The most undo steps kept; the oldest are dropped first. Snapshots are JSON strings of a few kilobytes each. */
export const MAX_STEPS = 200;

/**
 * A linear undo history of JSON documents. `commit` records the document after an edit; `undo` and `redo` return the
 * document to restore, as a fresh object the caller may mutate.
 */
export class History<T> {
    private steps : string[] = [];
    private at = -1;
    private lastKey : string | null = null;
    private lastTime = -Infinity;

    /** Starts over with `doc` as the only state: nothing to undo or redo. */
    reset( doc : T ) : void {
        this.steps = [JSON.stringify( doc )];
        this.at = 0;
        this.lastKey = null;
    }

    /**
     * Records `doc` as the state after an edit and drops whatever could have been redone. A document equal to the
     * current state records nothing. Consecutive commits with the same non-null `key` less than `COALESCE_MS` apart
     * replace each other, so dragging a slider is one step; `now` is the time of the edit in milliseconds.
     * Returns whether the history changed.
     */
    commit( doc : T, key : string | null = null, now = 0 ) : boolean {
        const s = JSON.stringify( doc );
        if (this.at < 0) { this.steps = [s]; this.at = 0; return true; }
        if (s == this.steps[this.at]) return false;
        const merge = key != null && key == this.lastKey && now - this.lastTime < COALESCE_MS && this.at > 0;
        this.steps.length = this.at + 1;
        if (merge && s == this.steps[this.at - 1]) {
            // dragged back to where it began: the step is gone, and the next edit must not merge into the one before
            this.steps.pop(); this.at--;
            this.lastKey = null;
            return true;
        }
        if (merge) this.steps[this.at] = s;
        else {
            this.steps.push( s );
            if (this.steps.length > MAX_STEPS + 1) this.steps.shift();
            this.at = this.steps.length - 1;
        }
        this.lastKey = key;
        this.lastTime = now;
        return true;
    }

    /** Whether there is an earlier state. */
    get canUndo() : boolean { return this.at > 0; }

    /** Whether an undone state can be restored. */
    get canRedo() : boolean { return this.at >= 0 && this.at < this.steps.length - 1; }

    /** Steps back one edit and returns the document to restore, or null when there is nothing to undo. */
    undo() : T | null {
        if (!this.canUndo) return null;
        this.lastKey = null;
        return JSON.parse( this.steps[--this.at] ) as T;
    }

    /** Steps forward one undone edit and returns the document to restore, or null when there is nothing to redo. */
    redo() : T | null {
        if (!this.canRedo) return null;
        this.lastKey = null;
        return JSON.parse( this.steps[++this.at] ) as T;
    }
}
