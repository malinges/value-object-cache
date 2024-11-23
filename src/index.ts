export type Value = Primitive | ValueArray | ValueObject;

export type Primitive = string | number | boolean | symbol | bigint | null | undefined;

export interface ValueArray extends ReadonlyArray<Value> {}

const VALUE_OBJECT_BRAND = Symbol();

export abstract class ValueObject<T extends object = object> {
  readonly [VALUE_OBJECT_BRAND] = true;

  constructor(protected readonly props: Readonly<T>) {
    Object.freeze(this.props);
    return valueObjectCache.getObjectByValue(this.constructor, this.toValues(), () => this);
  }

  protected abstract toValues(): ValueArray;
}

export type ReadonlyValue<T extends Value> =
  T extends readonly [infer U extends Value, ...(infer R extends readonly Value[])]
    ? R extends [...never[]]
      ? readonly [ReadonlyValue<U>]
      : readonly [ReadonlyValue<U>, ...ReadonlyValue<R>]
    : T extends readonly (infer U extends Value)[]
      ? readonly ReadonlyValue<U>[]
      : T;

export function isPrimitive(x: unknown): x is Primitive {
  return typeof x !== 'function' && (typeof x !== 'object' || x === null);
}

export function isValueArray(x: unknown): x is ValueArray {
  return Array.isArray(x) && x.every(isValue);
}

export function isValueObject(x: unknown): x is ValueObject {
  return x instanceof ValueObject;
}

export function isValue(x: unknown): x is Value {
  return isPrimitive(x) || isValueArray(x) || isValueObject(x);
}

/** A cache tree node used to store an object {@link WeakRef} and a {@link Map} of child nodes, both optional. */
interface CacheTreeNode {
  children: Map<unknown, CacheTreeNode> | null;
  instanceRef: WeakRef<object> | null;
}

/**
 * A value object cache that can be used to make value objects behave like primitive types, i.e. if two variables `a`
 * and `b` point to an instance of the same class and have the same value, then `a === b`, otherwise `a !== b`.
 *
 * To achieve this, the cache can be queried with three arguments: a class constructor, an array of values, and a
 * factory function. Values represent the "identity" of an instance: all calls to the cache with the same constructor
 * and instance parameters (according to the [same-value-zero equality](
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Equality_comparisons_and_sameness#same-value-zero_equality))
 * will return the same instance. If the cache already contains an instance of this class with the same values, then it
 * is returned. Otherwise, the provided factory is called to create a new instance, which is then stored in the cache
 * and returned - all the following calls to the cache with the same constructor and values will now return this
 * instance until it is garbage-collected. Because, as the cache only stores weak references to the instances and their
 * constructors, they can still be garbage-collected once they become unreachable.
 *
 * While value objects aren't usually expected to have the same identity when they're equal, making sure they do can
 * make life easier in situations where specifying a custom equality function isn't practical or even doable, such as
 * when using React hooks like {@link useCallback}, {@link useMemo}, {@link useEffect}, etc.
 *
 * // TODO update doc
 *
 * @see https://en.wikipedia.org/wiki/Value_object
 *
 * @example
 * ```ts
 * abstract class Dimension<Unit extends string> {
 *   constructor(
 *     readonly scalar: number,
 *     readonly unit: Unit,
 *   ) {
 *     Object.freeze(this);
 *     return valueObjectCache.getInstance(this.constructor, [scalar, unit], () => this);
 *   }
 * }
 *
 * type LengthUnit = 'mm' | 'm' | 'km';
 * class Length extends Dimension<LengthUnit> {}
 * class OtherLength extends Dimension<LengthUnit> {}
 *
 * console.log(new Length(1, 'm') === new Length(1, 'm')); // outputs 'true'
 * console.log(new Length(1, 'm') === new Length(2, 'm')); // outputs 'false'
 * console.log(new Length(1, 'm') === new OtherLength(1, 'm')); // outputs 'false'
 * ```
 */
export const valueObjectCache = new (class ValueObjectCache {
  readonly #rootNode: CacheTreeNode = { children: null, instanceRef: null };

  readonly #finalizationRegistry = new FinalizationRegistry<readonly unknown[]>((path) => {
    const walkedNodes: { currentNode: CacheTreeNode; parentNode: CacheTreeNode | null; parentKey: unknown }[] = [
      { currentNode: this.#rootNode, parentNode: null, parentKey: null },
    ];

    let node = this.#rootNode;
    for (const key of path) {
      const childNode = node.children?.get(key);
      if (!childNode) break;
      walkedNodes.push({ currentNode: childNode, parentNode: node, parentKey: key });
      node = childNode;
    }

    walkedNodes.reverse();

    for (const { currentNode, parentNode, parentKey } of walkedNodes) {
      if (currentNode.children && !currentNode.children.size) currentNode.children = null;
      if (currentNode.instanceRef && !currentNode.instanceRef.deref()) currentNode.instanceRef = null;
      if (currentNode.children || currentNode.instanceRef) break;
      parentNode?.children?.delete(parentKey);
    }
  });

  #get<T extends object>(constructor: Function, values: ValueArray, factory: () => T): T {
    const path = [constructor, ...values];
    let node = this.#rootNode;
    // console.log('#get()', path);

    for (const key of path) {
      if (!node.children) node.children = new Map();
      let childNode = node.children.get(key);
      if (!childNode) {
        childNode = { children: null, instanceRef: null };
        node.children.set(key, childNode);
      }
      node = childNode;
    }

    const cachedInstance = node.instanceRef?.deref();
    if (cachedInstance) return cachedInstance as T;

    const instance = factory();
    if (instance.constructor !== constructor) {
      throw new TypeError('factory must return an instance of the provided constructor');
    }

    // console.log('storing', instance, 'at path', path);
    node.instanceRef = new WeakRef(instance);
    this.#finalizationRegistry.register(instance, path);

    return instance;
  }

  /** Look for an instance of the provided class constructor matching the provided values. If a matching instance is
   * found then it is returned, otherwise the factory function is called to create a new instance, which is then stored
   * in the cache and returned - all future calls to this method made with the same constructor and values will return
   * this instance until it is garbage-collected. */
  getObjectByValue<const T extends object>(constructor: Function, values: ValueArray, factory: () => T): T {
    return this.#get(constructor, values.map((v) => this.getByValue(v)), () => Object.freeze(factory()));
  }

  /** Look for an {@link Array} containing a specific list of values in the cache. If a matching {@link Array} is found
   * then it is returned, otherwise a new {@link Array} is stored in the cache and returned. All returned arrays are
   * frozen (readonly). */
  getArrayByValue<const T extends ValueArray>(values: T): ReadonlyValue<T> {
    const array = values.map((v) => this.getByValue(v));
    return this.#get(Array, array, () => Object.freeze(array)) as ReadonlyValue<T>;
  }

  getByValue<const T extends Value>(value: T): ReadonlyValue<T> {
    // getByValueStack.push(value);
    // console.log(`[${++getByValueNum}-${getByValueStack.length}] getByValue()`, value);
    // console.log('stack', getByValueStack);
    try {
      if (isPrimitive(value)) {
        return value as ReadonlyValue<T>;
      } else if (Array.isArray(value)) {
        return this.getArrayByValue(value);
      } else if (isValueObject(value)) {
        return value as ReadonlyValue<T>;
      } else {
        throw new TypeError('Invalid value type: a value must be a primitive, an array, or a ValueObject.');
      }
    } finally {
      // getByValueStack.pop();
    }
  }
})();

// let getByValueNum = 0;
// let getByValueStack: unknown[] = [];

// type LengthUnit = 'mm' | 'm' | 'km';
// export class Length extends ValueObject<{scalar: number; unit: LengthUnit}> {
//   constructor(scalar: number, unit: LengthUnit) {
//     super({ scalar, unit });
//   }
//   protected toValues(): ValueArray {
//     return [this.props.scalar, this.props.unit];
//   }
// }

// const getObj1 = () =>
//   valueObjectCache.getByValue([
//     ['a', [1, 2, ['foo', 'bar']]],
//     ['b', [3, 4, ['baz', 'qux']]],
//     ['c', new Length(100, 'km')],
//   ]);

// const obj11 = getObj1();
// const obj12 = getObj1();

// if (obj11 !== obj12) {
//   throw new Error('getObj1() returned different objects');
// }
