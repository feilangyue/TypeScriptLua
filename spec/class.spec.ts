import { Run } from '../src/compiler';
import { expect } from 'chai';
import { describe, it } from 'mocha';

describe('Classes', () => {

    it('Class static member', () => expect('Hello\r\n').to.equals(new Run().test([
        'class Class1 {                                 \
            public static show() {                      \
                console.log("Hello");                   \
            }                                           \
        }                                               \
                                                        \
        Class1.show();                                  \
    '])));

    it('Class static member with parameter', () => expect('Hello\r\n').to.equals(new Run().test([
        'class Class1 {                                 \
            public static show(s:string) {              \
                console.log(s);                         \
            }                                           \
        }                                               \
                                                        \
        Class1.show("Hello");                           \
    '])));

    it.skip('Class private member in constructor', () => expect('1\r\n').to.equals(new Run().test([
        'class Class1 {                                     \
            constructor(private i: number) {                \
            }                                               \
                                                            \
            public show() {                                 \
              console.log(this.i);                          \
            }                                               \
          }                                                 \
                                                            \
          let c = new Class1(1);                            \
          c.show();                                         \
                                                            \
    '])));

    it.skip('Class inheritance', () => expect('false\r\nfalse\r\n').to.equals(new Run().test([
        'class Class1 {                                     \
            public method1(): boolean {                     \
                return false;                               \
            }                                               \
        }                                                   \
        class Class2 extends Class1 {                       \
        }                                                   \
        const c1 = new Class1();                            \
        console.log(c1.method1());                          \
        const c2 = new Class2();                            \
        console.log(c2.method1());                          \
    '])));

});
