import { v4 as uuidv4 } from 'uuid'
import { createElement } from 'utils/createElement'
import { EventBus } from './EventBus'

const enum EVENTS {
  INIT = 'init',
  FLOW_CDM = 'flow:component-did-mount',
  FLOW_CDU = 'flow:component-did-update',
  FLOW_RENDER = 'flow:render',
}

export interface RootTag {
  tag: string,
  className: string,
  attr: Record<string, string>,
  parentEvents: Record<string, EventListener>
}

type HTMLChildren = string | Node | (string | Node)[]

type Props = Record<string, unknown>

export type BlockBuilder<T = Props> = T extends Props ? (() => Block<T>) : never

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export abstract class Block<T extends Props = any> {
  public blockName: string = this.constructor.name

  #id = uuidv4()

  #meta: { root: RootTag, props: Props }

  #props: Props

  #element: HTMLElement

  #events: RootTag['parentEvents'] = {}

  eventBus: () => EventBus<EVENTS>

  constructor(
    {
      tag = 'div', className = '', attr = {}, parentEvents = {},
    }: Partial<RootTag> = {},
    props = {} as T,
  ) {
    this.#meta = {
      root: {
        tag, className, attr, parentEvents,
      },
      props,
    }
    const eventBus = new EventBus<EVENTS>()
    this.eventBus = () => eventBus

    this.#props = this.#makePropsProxy(props)
    this.#element = this.#createResources()

    this.#registerEvents(eventBus)
    eventBus.emit(EVENTS.INIT)
  }

  #registerEvents(eventBus: EventBus<EVENTS>) {
    eventBus.on(EVENTS.INIT, this.#init)
    eventBus.on(EVENTS.FLOW_CDM, this.#componentDidMount)
    eventBus.on(EVENTS.FLOW_CDU, this.#componentDidUpdate)
    eventBus.on(EVENTS.FLOW_RENDER, this.#render)
  }

  #createResources() {
    const { root: { tag, className, attr } } = this.#meta
    return createElement(tag, {
      ...attr,
      class: className,
    })
  }

  #init = () => {
    this.#addParentEvents()
    queueMicrotask(() => this.eventBus().emit(EVENTS.FLOW_RENDER))
  }

  public unmount() {
    this.#removeParentEvents()
    this.#element.remove()
    if (process.env.NODE_ENV === 'development') {
      console.debug(`> Unmounted «${this.blockName}»`)
    }
  }

  #componentDidMount = () => {
    this.componentDidMount(this.props)

    const { children } = this.#splitPropsByType(this.props)
    children.forEach((child) => child.dispatchComponentDidMount())
  }

  // @ts-expect-error default implementation
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected componentDidMount(props: T): void {
    if (process.env.NODE_ENV === 'development') {
      console.debug(`> Mounted «${this.blockName}» with props`, this.#meta.props)
    }
  }

  public dispatchComponentDidMount() {
    this.eventBus().emit(EVENTS.FLOW_CDM)
  }

  #componentDidUpdate = (oldProps: Props, newProps: Props, changedProps: (keyof T)[]) => {
    const response = this.componentDidUpdate(oldProps as T, newProps as T, changedProps)
    if (response) this.eventBus().emit(EVENTS.FLOW_RENDER)
  }

  // @ts-expect-error default implementation
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected componentDidUpdate(oldProps: T, newProps: T, changedProps: Readonly<keyof T>[]) {
    return true
  }

  #setUpdateProps: (keyof T)[] = []

  public setProps = (nextProps: Partial<T>) => {
    const oldProps = { ...this.#props }

    this.#setUpdateProps = []
    Object.assign(this.#props, nextProps)

    if (this.#setUpdateProps.length) {
      this.eventBus().emit(EVENTS.FLOW_CDU, oldProps, this.#props, this.#setUpdateProps)
      this.#setUpdateProps = []
    }
  }

  public get props(): Readonly<T> {
    return this.#props as T
  }

  public getContent(): HTMLElement {
    return this.#element
  }

  #makePropsProxy(props: Props): Props {
    const proxyProps = new Proxy(props, {
      get(target, prop: string): unknown {
        const value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
      },
      set: (target, prop, value) => {
        const p = prop as keyof Props
        if (p in target && target[p] !== value) {
          target[p] = value
          this.#setUpdateProps.push(p)
        }
        return true
      },
      deleteProperty(_target, prop: string): never {
        throw new Error(`Нет доступа к ${prop}`)
      },
    })

    return proxyProps
  }

  #addParentEvents() {
    const { parentEvents: events } = this.#meta.root
    this.#events = { ...events }
    Object.entries(events).forEach(([name, fn]) => {
      this.#element.addEventListener(name, fn)
    })
  }

  #removeParentEvents() {
    Object.entries(this.#events).forEach(([name, fn]) => {
      this.#element.removeEventListener(name, fn)
    })
    this.#events = {}
  }

  protected compile(
    template: ((context: Record<string, unknown>) => string),
    overrideProps: Record<string, unknown> = {},
  ): DocumentFragment {
    const props = { ...this.props, ...overrideProps }

    const { children, events, propsAndStubs } = this.#splitPropsByType(props)

    const dom = document.createElement('template')
    const html = template(propsAndStubs)
    dom.innerHTML = html

    children.forEach((child) => {
      const el = dom.content.querySelector(`stub[data-id="${child.#id}"]`)
      if (!el) return

      el.replaceWith(child.getContent())
    })

    const eventNames = html.match(/on:[a-z]+="/g) ?? []
    eventNames.forEach((eventName) => {
      eventName = eventName.slice(3, -2)
      const nodes = dom.content.querySelectorAll(`[on\\:${eventName}]`)
      nodes.forEach((node) => {
        const attr = node.getAttribute(`on:${eventName}`)
        const handler = events[attr ?? '']
        if (handler) node.addEventListener(eventName, handler)
        node.removeAttribute(`on:${eventName}`)
      })
    })

    return dom.content
  }

  protected render(): HTMLChildren {
    return ''
  }

  #render = () => {
    const block = this.render()
    this.#removeParentEvents()

    this.#element.innerHTML = ''

    if (block) {
      this.#element.append(...[block].flat())
    }

    if (process.env.NODE_ENV === 'development') {
      console.debug(`> Rendered «${this.blockName}» with props`, this.#meta.props)
    }

    this.#addParentEvents()
  }

  #splitPropsByType(props: Props) {
    const propsAndStubs: Record<string, unknown> = {}
    const events: Record<string, EventListener | undefined> = {}
    const children: Block[] = []

    Object.entries(props).forEach(([key, value]) => {
      if (typeof value === 'function') {
        events[key] = value as EventListener
      } else if (value instanceof Block) {
        children.push(value)
        propsAndStubs[key] = `<stub data-id="${value.#id}"></stub>`
      } else if (Array.isArray(value)) {
        const items = value.map((item) => {
          if (!item || typeof item !== 'object') {
            return String(item)
          }
          if (item instanceof Block) {
            children.push(item)
            return `<stub data-id="${item.#id}"></stub>`
          }
          return item as unknown
        })
        propsAndStubs[key] = items
      } else {
        propsAndStubs[key] = value
      }
    })
    return { propsAndStubs, events, children }
  }

  show() {
    this.#element.hidden = false
  }

  hide() {
    this.#element.hidden = true
  }
}
