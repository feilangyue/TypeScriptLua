declare var table: any;
declare var len: any;
declare var __len__: any;

module JS {

    export class Array<T> {

        [k: number]: T;

        public push(obj: T) {
            if (!this[0]) {
                this[0] = obj;
                return;
            }
 
            table.insert(this, obj);
        }

        public pop() {
            const l = this.length();
            if (l === 0) {
                throw 'Out of items';
            }

            if (l === 1) {
                const v = this[0];
                delete this[0];
                return v;
            }

            return table.remove(this);
        }

        @len
        public get length(): number {
            // implemented in the compiler
            throw 0;
        }
    }

}
