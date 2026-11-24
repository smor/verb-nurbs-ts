import { Pair, Point } from "./Data.js";

//A Haxe port of:
//
//k-d Tree JavaScript - V 1.0
//
//https://github.com/ubilabs/kd-tree-javascript
//
//@author Mircea Pricop <pricop@ubilabs.net>, 2012
//@author Martin Kleppe <kleppe@ubilabs.net>, 2012
//@author Ubilabs http://ubilabs.net, 2012
//@license MIT License <http://www.opensource.org/licenses/mit-license.php>

export class KdTree<T> {

    private points : Array<KdPoint<T>>;
    private distanceFunction : ((a0: Point, a1: Point) => number);
    private dim : number = 3;
    private root : KdNode<T>;

    constructor(points : Array<KdPoint<T>>, distanceFunction : ((a0: Point, a1: Point) => number)) {
        this.points = points;
        this.distanceFunction = distanceFunction;
        this.dim = points[0].point.length;

        this.root = this.buildTree(points, 0, null);
    }

    private buildTree(points : Array<KdPoint<T>>, depth : number, parent : KdNode<T>) : KdNode<T> {
        let dim = depth % this.dim,
            median,
            node;

        if (points.length == 0) return null;
        if (points.length == 1) return new KdNode<T>(points[0], dim, parent);

        points.sort(function(a : KdPoint<T>, b : KdPoint<T>) {
            let diff = a.point[dim] - b.point[dim];
            if (diff == 0.0){
                return 0;
            } else if (diff > 0) {
                return 1;
            } else {
                return -1;
            }
        });

        median = Math.floor(points.length / 2);

        node = new KdNode(points[median], dim, parent);

        node.left = this.buildTree( points.slice(0, median), depth + 1, node);
        node.right = this.buildTree( points.slice(median + 1), depth + 1, node);

        return node;
    }

    public nearest(point : Point, maxNodes : number, maxDistance : number ) : Array<Pair<KdPoint<T>, number>> {

        let bestNodes = new BinaryHeap<KdNode<T>>(
            function (e : Pair<KdNode<T>, number>) { return -e.item1; }
        );

        const nearestSearch = (node : KdNode<T>) => {

            let bestChild,
                dimension = node.dimension,
                ownDistance = this.distanceFunction( point, node.kdPoint.point ),
                linearPoint = Array.from({ length: this.dim }, (_, i) => 0.0),
                linearDistance,
                otherChild,
                i;

            function saveNode(node : KdNode<T>, distance : number) : void {
                bestNodes.push(new Pair(node, distance));
                if (bestNodes.size() > maxNodes) {
                    bestNodes.pop();
                }
            }

            for (let i = 0; i < this.dim; i++) {
                if (i == node.dimension) {
                    linearPoint[i] = point[i];
                } else {
                    linearPoint[i] = node.kdPoint.point[i];
                }
            }

            linearDistance = this.distanceFunction( linearPoint, node.kdPoint.point );

            if (node.right == null && node.left == null) {
                if (bestNodes.size() < maxNodes || ownDistance < bestNodes.peek().item1) {
                    saveNode(node, ownDistance);
                }
                return;
            }

            if (node.right == null) {
                bestChild = node.left;
            } else if (node.left == null) {
                bestChild = node.right;
            } else {
                if (point[dimension] < node.kdPoint.point[dimension]) {
                    bestChild = node.left;
                } else {
                    bestChild = node.right;
                }
            }

            nearestSearch( bestChild );

            if (bestNodes.size() < maxNodes || ownDistance < bestNodes.peek().item1) {
                saveNode(node, ownDistance);
            }

            if (bestNodes.size() < maxNodes || Math.abs(linearDistance) < bestNodes.peek().item1) {
                if (bestChild == node.left) {
                    otherChild = node.right;
                } else {
                    otherChild = node.left;
                }
                if (otherChild != null) {
                    nearestSearch(otherChild);
                }
            }
        }

        for (let i = 0; i < maxNodes; i++) {
            bestNodes.push(new Pair<KdNode<T>, number>(null, maxDistance));
        }

        nearestSearch( this.root );

        let result = [];

        for (let i = 0; i < maxNodes; i++) {
            if (bestNodes.content[i].item0 != null) {
                result.push(new Pair<KdPoint<T>, number>(bestNodes.content[i].item0.kdPoint, bestNodes.content[i].item1));
            }
        }

        return result;
    }
}

//Binary heap implementation from:
//http://eloquentjavascript.net/appendix2.html

export class BinaryHeap<T> {

    public content : Array<Pair<T, number>>;
    private scoreFunction : ((a0: Pair<T, number>) => number);

    constructor(scoreFunction : ((a0: Pair<T, number>) => number)){
        this.content = [];
        this.scoreFunction = scoreFunction;
    }

    public push(element : Pair<T, number>) : void {
        //Add the new element to the end of the array.
        this.content.push(element);
        //Allow it to bubble up.
        this.bubbleUp(this.content.length - 1);
    }

    public pop() : Pair<T, number> {
        //Store the first element so we can return it later.
        let result = this.content[0];
        //Get the element at the end of the array.
        let end = this.content.pop();
        //If there are any elements left, put the end element at the
        //start, and let it sink down.
        if (this.content.length > 0) {
            this.content[0] = end;
            this.sinkDown(0);
        }
        return result;
    }

    public peek() : Pair<T, number> {
        return this.content[0];
    }

    public remove(node : Pair<T, number>) : void {
        let len = this.content.length;
        //To remove a value, we must search through the array to find
        //it.
        for (let i = 0; i < len; i++) {
            if (this.content[i] == node) {
                //When it is found, the process seen in 'pop' is repeated
                //to fill up the hole.
                let end = this.content.pop();
                if (i != len - 1) {
                    this.content[i] = end;
                    if (this.scoreFunction(end) < this.scoreFunction(node))
                        this.bubbleUp(i);
                    else
                        this.sinkDown(i);
                }
                return;
            }
        }
        throw "Node not found.";
    }

    public size() : number {
        return this.content.length;
    }

    private bubbleUp(n : number) : void {
        //Fetch the element that has to be moved.
        let element = this.content[n];
        //When at 0, an element can not go up any further.
        while (n > 0) {
            //Compute the parent element's index, and fetch it.
            let parentN = Math.floor((n + 1.0) / 2) - 1,
            parent = this.content[parentN];
            //Swap the elements if the parent is greater.
            if (this.scoreFunction(element) < this.scoreFunction(parent)) {
                this.content[parentN] = element;
                this.content[n] = parent;
                //Update 'n' to continue at the new position.
                n = parentN;
            }
            //Found a parent that is less, no need to move it further.
            else {
                break;
            }
        }
    }

    private sinkDown(n : number) : void {
        //Look up the target element and its score.
        let length = this.content.length,
        element = this.content[n],
        elemScore = this.scoreFunction(element);

        while(true) {
            //Compute the indices of the child elements.
            let child2N = (n + 1) * 2;
            let child1N = child2N - 1;
            //This is used to store the new position of the element,
            //if any.
            let swap = -1;
            let child1Score : number = 0.0;

            //If the first child exists (is inside the array)...
            if (child1N < length) {
                //Look it up and compute its score.
                let child1 = this.content[child1N];
                child1Score = this.scoreFunction(child1);
                //If the score is less than our element's, we need to swap.
                if (child1Score < elemScore)
                    swap = child1N;
            }
            //Do the same checks for the other child.
            if (child2N < length) {
                let child2 = this.content[child2N];
                let child2Score = this.scoreFunction(child2);
                if (child2Score < (swap == -1 ? elemScore : child1Score)){
                    swap = child2N;
                }
            }

            //If the element needs to be moved, swap it, and continue.
            if (swap != -1) {
                this.content[n] = this.content[swap];
                this.content[swap] = element;
                n = swap;
            }
            //Otherwise, we are done.
            else {
                break;
            }
        }
    }
}

// A point in a KdTree
export class KdPoint<T> {

    // The point
    public point : Point;

    // An arbitrary object to attach
    public obj : T;

    constructor(point : Point, obj : T){
        this.point = point;
        this.obj = obj;
    }
}

// A node in a KdTree
export class KdNode<T> {

    // The point itself
    public kdPoint : KdPoint<T>;

    // The left child
    public left : KdNode<T>;

    // The right child
    public right : KdNode<T>;

    // The parent of the node
    public parent : KdNode<T>;

    // The dimensionality of the point
    public dimension : number;

    constructor(kdPoint : KdPoint<T>, dimension : number, parent : KdNode<T>) {
        this.kdPoint = kdPoint;
        this.left = null;
        this.right = null;
        this.parent = parent;
        this.dimension = dimension;
    }
}
