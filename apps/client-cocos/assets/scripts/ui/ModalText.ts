import { BlockInputEvents, Button, Color, Graphics, Label, Mask, Node, ScrollView, UITransform } from 'cc';

export const MODAL_WIDTH = 760;
export const MODAL_HEIGHT = 520;

export const TEXT = new Color(245, 240, 229);
export const GOLD = new Color(237, 204, 140);
export const SURFACE = new Color(20, 43, 36);
export const MUTED = new Color(184, 205, 191);
const CONTROL = new Color(28, 56, 46);
const CONTROL_BORDER = new Color(115, 147, 130);
const INK = new Color(36, 36, 25);

export function card(parent: Node, name: string, x: number, y: number, w: number, h: number, color = SURFACE): Node {
  const node = new Node(name);
  parent.addChild(node);
  node.setPosition(x, y);
  node.addComponent(UITransform).setContentSize(w, h);
  const paint = node.addComponent(Graphics);
  paint.fillColor = color;
  paint.strokeColor = new Color(75, 107, 90);
  paint.lineWidth = 2;
  paint.roundRect(-w / 2, -h / 2, w, h, 14);
  paint.fill();
  paint.stroke();
  return node;
}

export function addLabel(parent: Node, text: string, x: number, y: number, w: number, h: number, font = 24, color = TEXT, left = false): Label {
  const node = new Node('Label');
  parent.addChild(node);
  node.setPosition(x, y);
  node.addComponent(UITransform).setContentSize(w, h);
  const label = node.addComponent(Label);
  label.string = text;
  label.fontSize = font;
  label.lineHeight = font + 5;
  label.color = color;
  label.horizontalAlign = left ? Label.HorizontalAlign.LEFT : Label.HorizontalAlign.CENTER;
  label.verticalAlign = Label.VerticalAlign.CENTER;
  label.overflow = Label.Overflow.SHRINK;
  return label;
}

export function modalSize(node: Node): { width: number; height: number } {
  const size = node.parent?.getComponent(UITransform)?.contentSize;
  return { width: Math.min(MODAL_WIDTH, (size?.width ?? 1280) - 32), height: Math.min(MODAL_HEIGHT, (size?.height ?? 720) - 36) };
}

export function drawModal(node: Node, width = modalSize(node).width, height = modalSize(node).height, screenWidth?: number, screenHeight?: number): void {
  const transform = node.getComponent(UITransform) ?? node.addComponent(UITransform);
  const size = node.parent?.getComponent(UITransform)?.contentSize;
  const viewportWidth = screenWidth ?? size?.width ?? 1280;
  const viewportHeight = screenHeight ?? size?.height ?? 720;
  transform.setContentSize(viewportWidth, viewportHeight);
  if (!node.getComponent(BlockInputEvents)) node.addComponent(BlockInputEvents);
  const background = node.getComponent(Graphics) ?? node.addComponent(Graphics);
  background.clear();
  background.fillColor = new Color(0, 0, 0, 145);
  background.rect(-viewportWidth / 2, -viewportHeight / 2, viewportWidth, viewportHeight);
  background.fill();
  background.fillColor = SURFACE;
  background.strokeColor = GOLD;
  background.lineWidth = 2;
  background.roundRect(-width / 2, -height / 2, width, height, 16);
  background.fill();
  background.roundRect(-width / 2, -height / 2, width, height, 16);
  background.stroke();
}

export function addScrollableText(parent: Node, width: number, height: number, y: number) {
  const area = new Node('Scroll');
  const viewport = new Node('Viewport');
  const content = new Node('Content');
  parent.addChild(area);
  area.addChild(viewport);
  viewport.addChild(content);
  area.setPosition(0, y);
  area.addComponent(UITransform).setContentSize(width, height);
  viewport.addComponent(UITransform).setContentSize(width, height);
  viewport.addComponent(Mask);

  const transform = content.addComponent(UITransform);
  transform.setAnchorPoint(0.5, 1);
  content.setPosition(0, height / 2);
  const label = content.addComponent(Label);
  label.fontSize = 20;
  label.lineHeight = 28;
  label.overflow = Label.Overflow.RESIZE_HEIGHT;
  label.enableWrapText = true;
  label.horizontalAlign = Label.HorizontalAlign.LEFT;
  label.verticalAlign = Label.VerticalAlign.TOP;
  label.color = TEXT;
  transform.setContentSize(width, height);

  const scroll = area.addComponent(ScrollView);
  scroll.horizontal = false;
  scroll.elastic = false;
  scroll.content = content;
  return { label, scroll };
}

export function addTextButton(
  parent: Node,
  text: string,
  x: number,
  y: number,
  width: number,
  primary = false,
  height = 56,
): Button {
  const node = new Node(text);
  parent.addChild(node);
  node.setPosition(x, y);
  node.addComponent(UITransform).setContentSize(width, height);

  const background = node.addComponent(Graphics);
  background.fillColor = primary ? GOLD : CONTROL;
  background.strokeColor = primary ? GOLD : CONTROL_BORDER;
  background.lineWidth = 2;
  background.roundRect(-width / 2 + 1, -height / 2 + 1, width - 2, height - 2, 10);
  background.fill();
  background.roundRect(-width / 2 + 1, -height / 2 + 1, width - 2, height - 2, 10);
  background.stroke();

  const labelNode = new Node('Text');
  node.addChild(labelNode);
  labelNode.addComponent(UITransform).setContentSize(width - 16, height - 8);
  const label = labelNode.addComponent(Label);
  label.string = text;
  label.fontSize = 24;
  label.lineHeight = 30;
  label.isBold = primary;
  label.color = primary ? INK : TEXT;
  label.overflow = Label.Overflow.SHRINK;
  label.horizontalAlign = Label.HorizontalAlign.CENTER;
  label.verticalAlign = Label.VerticalAlign.CENTER;

  const button = node.addComponent(Button);
  button.transition = Button.Transition.SCALE;
  button.zoomScale = 0.96;
  button.duration = 0.08;
  return button;
}
