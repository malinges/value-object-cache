/** A cache tree node used to store an instance {@link WeakRef} and a {@link Map} of child nodes, both optional. */
interface CacheTreeNode {
  children: Map<unknown, CacheTreeNode> | null;
  instanceRef: WeakRef<object> | null;
}

/**
 * A value object cache that can be used to make value objects behave like primitive types, i.e. if two variables `a`
 * and `b` point to an instance of the same class and have the same value, then `a === b`, otherwise `a !== b`.
 *
 * To achieve this, the cache can be queried with three arguments: a class constructor, an array of instance parameters,
 * and a factory function. Instance parameters represent the value of an instance: all calls to the cache with the same
 * constructor and instance parameters (according to the [same-value-zero equality](
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Equality_comparisons_and_sameness#same-value-zero_equality))
 * will return the same instance. If the cache already contains an instance of this class with the same value /
 * parameters, then it is returned. Otherwise, the provided factory is called to create a new instance, which is then
 * stored in the cache and returned - all the following calls to the cache with the same constructor and instance
 * parameters will now return this instance until it is garbage-collected. Because, as the cache only stores weak
 * references to the instances and their constructors, they can still be garbage-collected once they become unreachable.
 *
 * While value objects aren't usually expected to have the same identity when they're equal, making sure they do can
 * make life easier in situations where specifying a custom equality function isn't practical or even doable, such as
 * when using React hooks like {@link useCallback}, {@link useMemo}, {@link useEffect}, etc.
 *
 * Since this cache is meant to be used with value objects, it is highly suggested to call `Object.freeze()` on all
 * instances, and to make all of their properties immutable, `readonly`, and of course, `private` when applicable.
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

  /** Look for an instance of the provided class constructor matching the provided instance parameters. If a matching
   * instance is found then it is returned, otherwise the factory function is called to create a new instance, which is
   * then stored in the cache and returned - all future calls to this method made with the same constructor and instance
   * parameters will return this instance until it is garbage-collected. */
  getInstance<T extends object>(constructor: Function, instanceParams: readonly unknown[], instanceFactory: () => T): T {
    const path = [constructor, ...instanceParams];

    let node = this.#rootNode;
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

    const instance = instanceFactory();
    if (instance.constructor !== constructor) {
      throw new TypeError('factory must return an instance of the provided constructor');
    }

    node.instanceRef = new WeakRef(instance);
    this.#finalizationRegistry.register(instance, path);

    return instance;
  }
})();
