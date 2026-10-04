"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type JSX,
} from "react";
import { LexicalExtensionComposer } from "@lexical/react/LexicalExtensionComposer";
import {
  HorizontalRuleExtension,
  INSERT_HORIZONTAL_RULE_COMMAND,
} from "@lexical/extension";
import { HistoryExtension } from "@lexical/history";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { useLexicalNodeSelection } from "@lexical/react/useLexicalNodeSelection";
import {
  RichTextExtension,
  HeadingNode,
  QuoteNode,
  $createHeadingNode,
  $createQuoteNode,
} from "@lexical/rich-text";
import {
  ListNode,
  ListExtension,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
} from "@lexical/list";
import {
  LinkExtension,
  LinkNode,
  TOGGLE_LINK_COMMAND,
  $createLinkNode,
} from "@lexical/link";
import { TableExtension } from "@lexical/table";
import { $patchStyleText, $setBlocksType } from "@lexical/selection";
import { mergeRegister } from "@lexical/utils";
import {
  Undo2,
  Redo2,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  AlignLeft,
  AlignCenter,
  AlignRight,
  ListOrdered,
  List,
  IndentDecrease,
  IndentIncrease,
  Link,
  Minus,
  ImagePlus,
  Signature,
} from "lucide-react";
import {
  defineExtension,
  ElementNode,
  configExtension,
  $createParagraphNode,
  $createTextNode,
  $createRangeSelection,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  $isElementNode,
  $parseSerializedNode,
  $setSelection,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_HIGH,
  DecoratorNode,
  DROP_COMMAND,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  INDENT_CONTENT_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_DOWN_COMMAND,
  OUTDENT_CONTENT_COMMAND,
  PASTE_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type SerializedElementNode,
  type TextFormatType,
} from "lexical";
import DOMPurify from "dompurify";
import { importRichDom } from "@/modules/mail/domain/rich-import";
import {
  plainTextDocument,
  safeRichUrl,
  validateRichDocument,
  type RichDocument,
} from "@/modules/mail/domain/rich-document";
import type { AttachmentView } from "@/modules/mail/domain/attachments";
import {
  automaticSignature,
  signatureContent,
  signatureFingerprint,
  type SignatureCatalog,
} from "@/modules/mail/domain/signature";
import type { RichNode } from "@/modules/mail/domain/rich-document";

type SignatureJson = SerializedElementNode & {
  signatureId: string;
  fingerprint: string;
};
export class AutomaticSignatureNode extends ElementNode {
  __signatureId: string;
  __fingerprint: string;
  static getType() {
    return "maildock-signature";
  }
  static clone(node: AutomaticSignatureNode) {
    return new AutomaticSignatureNode(
      node.__signatureId,
      node.__fingerprint,
      node.__key,
    );
  }
  constructor(id: string, fingerprint: string, key?: NodeKey) {
    super(key);
    this.__signatureId = id;
    this.__fingerprint = fingerprint;
  }
  static importJSON(value: SignatureJson) {
    return new AutomaticSignatureNode(
      value.signatureId,
      value.fingerprint,
    ).updateFromJSON(value);
  }
  exportJSON(): SignatureJson {
    return {
      ...super.exportJSON(),
      type: "maildock-signature",
      version: 1,
      signatureId: this.getLatest().__signatureId,
      fingerprint: this.getLatest().__fingerprint,
    };
  }
  createDOM() {
    return document.createElement("div");
  }
  updateDOM() {
    return false;
  }
  canBeEmpty() {
    return true;
  }
}
function $signatureTree(node: LexicalNode): RichNode {
  const json = node.exportJSON() as RichNode;
  if ($isElementNode(node))
    json.children = node.getChildren().map($signatureTree);
  return json;
}
export type ComposeSignatureOptions = {
  accountId: string;
  mode: "new" | "reply" | "forward";
  initialize: boolean;
  onResources: (resources: (AttachmentView & { kind: "staged" })[]) => void;
  onReady: (ready: boolean) => void;
};

function SignatureInsertion({
  options,
  draftId,
  disabled,
  onError,
}: {
  options: ComposeSignatureOptions;
  draftId: string;
  disabled: boolean;
  onError: (message: string) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const [catalog, setCatalog] = useState<SignatureCatalog>();
  const [catalogAccount, setCatalogAccount] = useState<string>();
  const [loadError, setLoadError] = useState("");
  const loadFailed = Boolean(loadError);
  const [retryLoad, setRetryLoad] = useState(0);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const previous = useRef<string | undefined>(undefined);
  const managedEmpty = useRef(false);
  const selection = useRef<ReturnType<typeof $getSelection>>(null);
  const sourceBoundary = useRef<NodeKey[]>([]);
  useEffect(() => {
    editor.getEditorState().read(() => {
      sourceBoundary.current =
        options.mode === "new"
          ? []
          : $getRoot()
              .getChildren()
              .slice(1)
              .map((n) => n.getKey());
    });
  }, [editor, options.mode]);
  const latestAccount = useRef(options.accountId);
  useEffect(() => {
    latestAccount.current = options.accountId;
  }, [options.accountId]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { accountId, mode, initialize, onResources, onReady } = options;
  useEffect(() => {
    let cancelled = false;
    onReady(false);
    void fetch("/api/signatures")
      .then(async (response) => {
        if (!response.ok)
          throw Error(
            "Signatures could not be loaded. Retry before saving or sending.",
          );
        const result = (await response.json()) as SignatureCatalog;
        if (
          !Array.isArray(result.signatures) ||
          !result.defaults ||
          typeof result.defaults !== "object"
        )
          throw Error("Invalid signature catalog. Retry loading signatures.");
        if (!cancelled) {
          setBusy(true);
          setLoadError("");
          setCatalog(result);
          setCatalogAccount(accountId);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setLoadError(e.message);
          setBusy(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onError, onReady, accountId, retryLoad]);
  async function snapshot(id: string) {
    const response = await fetch(`/api/signatures/${id}/snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId }),
    });
    const result = (await response.json()) as {
      richDocument: RichDocument;
      attachments: (AttachmentView & { kind: "staged" })[];
      error?: string;
    };
    if (!response.ok)
      throw Error(result.error ?? "Signature could not be inserted.");
    return result;
  }
  useEffect(() => {
    if (!catalog || catalogAccount !== accountId) return;
    let cancelled = false;
    let failed = false;
    const first = previous.current === undefined;
    onReady(false);
    const id = catalog.defaults[accountId]?.[mode] ?? null;
    void (async () => {
      if (previous.current === accountId) return;
      let current: RichNode | undefined;
      let key: NodeKey | undefined;
      editor.getEditorState().read(() => {
        const candidates = $getRoot()
          .getChildren()
          .filter((n) => n instanceof AutomaticSignatureNode);
        if (candidates.length === 1) {
          key = candidates[0].getKey();
          current = validateRichDocument({
            version: 1,
            editor: editor.getEditorState().toJSON(),
          }).editor.root.children!.find((n) => n.type === "maildock-signature");
        }
      });
      const canInsert = first ? initialize : managedEmpty.current;
      const untouched =
        current &&
        (await signatureFingerprint(current)) === current.fingerprint;
      if ((first && !initialize) || (!untouched && !canInsert)) {
        previous.current = accountId;
        return;
      }
      const result = id ? await snapshot(id) : null;
      const node =
        result && id ? await automaticSignature(id, result.richDocument) : null;
      if (cancelled) return;
      editor.update(
        () => {
          const existing = key ? $getNodeByKey(key) : null;
          // Recheck exact content after asynchronous work. User edits always win.
          if (
            current &&
            (!existing ||
              signatureContent($signatureTree(existing)) !==
                signatureContent(current))
          )
            return;
          if (
            !current &&
            $getRoot()
              .getChildren()
              .some((n) => n instanceof AutomaticSignatureNode)
          )
            return;
          if (result) onResources(result.attachments);
          if (existing) {
            if (node)
              existing.replace(
                $parseSerializedNode(node as SerializedLexicalNode),
              );
            else existing.remove();
          } else if (node) {
            const root = $getRoot();
            const parsed = $parseSerializedNode(node as SerializedLexicalNode);
            const boundary = sourceBoundary.current
              .map((key) => $getNodeByKey(key))
              .find((n) => n?.getParent()?.getKey() === root.getKey());
            if (boundary) boundary.insertBefore(parsed);
            else root.append(parsed);
          }
          managedEmpty.current = !node;
        },
        { discrete: true },
      );
      previous.current = accountId;
    })()
      .catch((e) => {
        failed = true;
        if (!cancelled) {
          setLoadError(e.message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          onReady(!failed);
          setBusy(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // snapshot only uses the stable draft ID; changes to account cancel in-flight work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    catalog,
    catalogAccount,
    accountId,
    mode,
    initialize,
    editor,
    onResources,
    onReady,
  ]);
  async function insert(id: string) {
    const capturedAccount = accountId;
    setBusy(true);
    onReady(false);
    setMenu(false);
    try {
      const result = await snapshot(id);
      if (!mounted.current || latestAccount.current !== capturedAccount) return;
      editor.update(
        () => {
          if (selection.current) $setSelection(selection.current);
          else $getRoot().selectEnd();
          onResources(result.attachments);
          $insertNodes(
            result.richDocument.editor.root.children!.map((n) =>
              $parseSerializedNode(n as SerializedLexicalNode),
            ),
          );
        },
        { discrete: true },
      );
    } catch (e) {
      if (mounted.current)
        onError(e instanceof Error ? e.message : "Signature insertion failed.");
    } finally {
      if (mounted.current) {
        setBusy(false);
        onReady(true);
      }
    }
  }
  return (
    <>
      {loadError ? (
        <span className="error" role="alert">
          {loadError}
        </span>
      ) : null}
      {loadFailed ? (
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => {
            setLoadError("");
            setBusy(true);
            setRetryLoad((n) => n + 1);
          }}
        >
          Retry signatures
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Insert signature"
        title="Insert signature"
        disabled={
          disabled ||
          busy ||
          loadFailed ||
          !catalog ||
          catalogAccount !== accountId
        }
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          editor.getEditorState().read(() => {
            selection.current = $getSelection()?.clone() ?? null;
          });
          if (catalog?.signatures.length === 1)
            void insert(catalog.signatures[0].id);
          else setMenu((v) => !v);
        }}
      >
        <Signature size={16} aria-hidden="true" />
      </button>
      {menu ? (
        <span role="group" aria-label="Choose signature">
          {catalog?.signatures.length ? (
            catalog.signatures.map((s) => (
              <button
                type="button"
                key={s.id}
                disabled={busy || disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void insert(s.id)}
              >
                {s.name}
              </button>
            ))
          ) : (
            <span>No signatures yet. Add one in Settings.</span>
          )}
        </span>
      ) : null}
    </>
  );
}

const PreviewContext = createContext({ draftId: "", revision: 0 });
type ImageJson = SerializedLexicalNode & {
  resourceId?: string;
  url?: string;
  alt: string;
  width: number;
};
export class ComposeImageNode extends DecoratorNode<JSX.Element> {
  __image: ImageJson;
  static getType() {
    return "maildock-image";
  }
  static clone(n: ComposeImageNode) {
    return new ComposeImageNode(n.__image, n.__key);
  }
  constructor(image: ImageJson, key?: NodeKey) {
    super(key);
    this.__image = image;
  }
  static importJSON(image: ImageJson) {
    return new ComposeImageNode(image);
  }
  exportJSON(): ImageJson {
    return { ...this.getLatest().__image, type: "maildock-image", version: 1 };
  }
  createDOM() {
    return document.createElement("span");
  }
  updateDOM() {
    return false;
  }
  isInline() {
    return true;
  }
  decorate() {
    return <ComposeImage nodeKey={this.__key} image={this.__image} />;
  }
}
function ComposeImage({
  nodeKey,
  image,
}: {
  nodeKey: NodeKey;
  image: ImageJson;
}) {
  const [editor] = useLexicalComposerContext();
  const [selected, setSelected, clear] = useLexicalNodeSelection(nodeKey);
  const { draftId, revision } = useContext(PreviewContext);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  return (
    <span
      className={`compose-image ${selected ? "selected" : ""}`}
      contentEditable={false}
    >
      <button
        type="button"
        aria-label={`Select image: ${image.alt}`}
        aria-pressed={selected}
        onClick={() => {
          clear();
          setSelected(true);
        }}
      >
        {image.resourceId &&
        !failed /* eslint-disable-next-line @next/next/no-img-element */ ? (
          <img
            key={`${revision}:${retry}`}
            src={`/api/attachments/staged/${image.resourceId}?draftId=${draftId}&revision=${revision}&retry=${retry}`}
            alt={image.alt}
            width={image.width}
            onError={() => setFailed(true)}
          />
        ) : (
          <span>
            {image.url
              ? `Remote image (preview blocked): ${image.alt || image.url}`
              : `Image preview unavailable: ${image.alt}`}
          </span>
        )}
      </button>
      {selected ? (
        <span className="compose-image-actions">
          <button
            type="button"
            onClick={() =>
              editor.update(() => $getNodeByKey(nodeKey)?.remove())
            }
          >
            Remove image
          </button>
          <button
            type="button"
            onClick={() => {
              const alt = window.prompt("Image description", image.alt);
              if (alt !== null)
                editor.update(() => {
                  const n = $getNodeByKey<ComposeImageNode>(nodeKey);
                  if (n)
                    n.getWritable().__image = {
                      ...n.__image,
                      alt: alt.slice(0, 500),
                    };
                });
            }}
          >
            Edit alt text
          </button>
          <select
            aria-label="Image width"
            value={image.width}
            onChange={(e) =>
              editor.update(() => {
                const n = $getNodeByKey<ComposeImageNode>(nodeKey);
                if (n)
                  n.getWritable().__image = {
                    ...n.__image,
                    width: Number(e.target.value),
                  };
              })
            }
          >
            {[160, 320, 480, 640].map((v) => (
              <option key={v} value={v}>
                {v}px
              </option>
            ))}
          </select>
        </span>
      ) : null}
      {failed && image.resourceId ? (
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            setRetry((v) => v + 1);
          }}
        >
          Retry preview
        </button>
      ) : null}
    </span>
  );
}
// Keep plugin dependencies stable: registering its transforms dirties existing links.
const validateLinkUrl = (url: string) => !!safeRichUrl(url);

function editLink(
  editor: LexicalEditor,
  onError: (message: string) => void,
  captured?: ReturnType<typeof $getSelection>,
) {
  let initial = "";
  let savedSelection = captured;
  editor.getEditorState().read(() => {
    const selection = captured ?? $getSelection();
    savedSelection = selection?.clone() ?? null;
    if ($isRangeSelection(selection)) {
      const n = selection.anchor.getNode();
      const link = n instanceof LinkNode ? n : n.getParent();
      if (link instanceof LinkNode) initial = link.getURL();
    }
  });
  const input = window.prompt("Link URL (leave empty to remove)", initial);
  if (input === null) return;
  const url = input ? safeRichUrl(input.trim()) : null;
  if (input && !url) {
    onError("Enter an HTTP, HTTPS or mailto link.");
    return;
  }
  editor.update(() => {
    if (savedSelection) $setSelection(savedSelection);
    const selection = $getSelection();
    if (
      url &&
      !initial &&
      (!selection || ($isRangeSelection(selection) && selection.isCollapsed()))
    ) {
      if (!selection) $getRoot().selectEnd();
      $insertNodes([
        $createLinkNode(url, { rel: null, target: null, title: null }).append(
          $createTextNode(url),
        ),
      ]);
    } else
      editor.dispatchCommand(
        TOGGLE_LINK_COMMAND,
        url ? { url, rel: null, target: null, title: null } : null,
      );
  });
}
function Toolbar({
  disabled,
  onError,
  signatureOptions,
  draftId,
}: {
  disabled: boolean;
  onError: (message: string) => void;
  signatureOptions?: ComposeSignatureOptions;
  draftId: string;
}) {
  const [editor] = useLexicalComposerContext();
  const [undo, setUndo] = useState(false),
    [redo, setRedo] = useState(false);
  const [formats, setFormats] = useState<string[]>([]);
  const [block, setBlock] = useState("paragraph");
  const [alignment, setAlignment] = useState("left");
  const [list, setList] = useState<string | null>(null);
  useEffect(
    () =>
      mergeRegister(
        editor.registerCommand(
          CAN_UNDO_COMMAND,
          (v) => {
            setUndo(v);
            return false;
          },
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand(
          CAN_REDO_COMMAND,
          (v) => {
            setRedo(v);
            return false;
          },
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerUpdateListener(({ editorState }) =>
          editorState.read(() => {
            const s = $getSelection();
            if ($isRangeSelection(s)) {
              setFormats(
                (
                  [
                    "bold",
                    "italic",
                    "underline",
                    "strikethrough",
                  ] as TextFormatType[]
                ).filter((f) => s.hasFormat(f)),
              );
              const anchor = s.anchor.getNode();
              const elements = [anchor, ...anchor.getParents()].filter(
                $isElementNode,
              );
              const heading = elements.find((n) => n instanceof HeadingNode) as
                HeadingNode | undefined;
              setBlock(
                heading?.getTag() ??
                  (elements.some((n) => n instanceof QuoteNode)
                    ? "quote"
                    : "paragraph"),
              );
              setAlignment(elements[0]?.getFormatType() || "left");
              const listNode = elements.find((n) => n instanceof ListNode) as
                ListNode | undefined;
              setList(listNode?.getListType() ?? null);
            }
          }),
        ),
      ),
    [editor],
  );
  const command = (
    label: string,
    action: () => void,
    pressed?: boolean,
    inactive = false,
  ) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled || inactive}
      onMouseDown={(e) => e.preventDefault()}
      onClick={action}
    >
      {(() => {
        const Icon = (
          {
            Undo: Undo2,
            Redo: Redo2,
            Bold,
            Italic,
            Underline,
            Strikethrough,
            "Align left": AlignLeft,
            "Align center": AlignCenter,
            "Align right": AlignRight,
            "Numbered list": ListOrdered,
            "Bulleted list": List,
            "Decrease indent": IndentDecrease,
            "Increase indent": IndentIncrease,
            Link,
            "Horizontal rule": Minus,
            "Image from URL": ImagePlus,
          } as Record<string, typeof Bold>
        )[label];
        return Icon ? <Icon size={16} aria-hidden="true" /> : label;
      })()}
    </button>
  );
  return (
    <div
      className="rich-toolbar"
      role="toolbar"
      aria-label="Message formatting"
    >
      {command(
        "Undo",
        () => editor.dispatchCommand(UNDO_COMMAND, undefined),
        undefined,
        !undo,
      )}
      {command(
        "Redo",
        () => editor.dispatchCommand(REDO_COMMAND, undefined),
        undefined,
        !redo,
      )}
      <select
        aria-label="Text style"
        disabled={disabled}
        value={block}
        onChange={(e) =>
          editor.update(() => {
            const s = $getSelection();
            if ($isRangeSelection(s))
              $setBlocksType(s, () =>
                e.target.value === "paragraph"
                  ? $createParagraphNode()
                  : e.target.value === "quote"
                    ? $createQuoteNode()
                    : $createHeadingNode(e.target.value as "h1" | "h2" | "h3"),
              );
          })
        }
      >
        <option value="paragraph">Paragraph</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
        <option value="quote">Block quote</option>
      </select>
      <select
        aria-label="Text size"
        disabled={disabled}
        defaultValue="16"
        onChange={(e) =>
          editor.update(() => {
            const s = $getSelection();
            if ($isRangeSelection(s))
              $patchStyleText(s, { "font-size": `${e.target.value}px` });
          })
        }
      >
        {[10, 12, 14, 16, 18, 24, 32, 48].map((v) => (
          <option value={v} key={v}>
            {v}px
          </option>
        ))}
      </select>
      {(
        ["bold", "italic", "underline", "strikethrough"] as TextFormatType[]
      ).map((f) => (
        <span key={f}>
          {command(
            f[0].toUpperCase() + f.slice(1),
            () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, f),
            formats.includes(f),
          )}
        </span>
      ))}
      <label title="Text color">
        <input
          type="color"
          aria-label="Text color"
          disabled={disabled}
          onChange={(e) =>
            editor.update(() => {
              const s = $getSelection();
              if ($isRangeSelection(s))
                $patchStyleText(s, { color: e.target.value });
            })
          }
        />
      </label>
      {(["left", "center", "right"] as const).map((a) => (
        <span key={a}>
          {command(
            `Align ${a}`,
            () => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, a),
            alignment === a,
          )}
        </span>
      ))}
      {command(
        "Numbered list",
        () => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined),
        list === "number",
      )}
      {command(
        "Bulleted list",
        () => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined),
        list === "bullet",
      )}
      {command("Decrease indent", () =>
        editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined),
      )}
      {command("Increase indent", () =>
        editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined),
      )}
      {command("Link", () => editLink(editor, onError))}
      {command("Horizontal rule", () =>
        editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined),
      )}
      {signatureOptions ? (
        <SignatureInsertion
          options={signatureOptions}
          draftId={draftId}
          disabled={disabled}
          onError={onError}
        />
      ) : null}
      {command("Image from URL", () => {
        const input = window.prompt(
          "Image URL (HTTP/HTTPS; preview stays blocked)",
        );
        if (!input) return;
        const url = safeRichUrl(input.trim(), true);
        if (!url) {
          onError("Enter an HTTP or HTTPS image URL.");
          return;
        }
        editor.update(() => {
          if (!$getSelection()) $getRoot().selectEnd();
          $insertNodes([
            new ComposeImageNode({
              type: "maildock-image",
              version: 1,
              url,
              alt: "Remote image",
              width: 480,
            }),
          ]);
        });
      })}
    </div>
  );
}
type Upload = (file: File, inline: boolean) => Promise<AttachmentView | null>;
function $insertClipboardContent(
  data: DataTransfer,
  onError: (message: string) => void,
) {
  try {
    const html = data.getData("text/html");
    let doc: RichDocument;
    if (html) {
      if (new TextEncoder().encode(html).length > 2_000_000)
        throw Error("Pasted content is too large.");
      // Neither paste nor external HTML drag may use Lexical's private JSON as
      // a shortcut around the controlled Maildock import policy.
      const clean = DOMPurify.sanitize(html, {
        RETURN_DOM: true,
        FORBID_TAGS: [
          "style",
          "script",
          "iframe",
          "object",
          "embed",
          "form",
          "svg",
          "math",
          "link",
          "meta",
          "base",
          "video",
          "audio",
          "source",
        ],
        FORBID_ATTR: ["src", "srcset", "background", "poster"],
        ALLOW_DATA_ATTR: false,
      });
      const inert = document.implementation.createHTMLDocument("");
      inert.body.replaceChildren(...Array.from(clean.childNodes));
      doc = importRichDom(inert);
    } else
      doc = validateRichDocument(plainTextDocument(data.getData("text/plain")));
    $insertNodes(
      doc.editor.root.children!.map((n) =>
        $parseSerializedNode(n as SerializedLexicalNode),
      ),
    );
  } catch (error) {
    onError(
      error instanceof Error ? error.message : "Content could not be imported.",
    );
  }
}
function Behavior({
  onChange,
  onError,
  onValidation,
  upload,
  disabled,
  editorRef,
}: {
  onChange: (doc: RichDocument) => void;
  onError: (message: string) => void;
  onValidation: (valid: boolean) => void;
  upload: Upload;
  disabled: boolean;
  editorRef: React.RefObject<LexicalEditor | null>;
}) {
  const [editor] = useLexicalComposerContext();
  const mounted = useRef(true);
  useEffect(() => {
    editorRef.current = editor;
    editor.setEditable(!disabled);
  }, [editor, disabled, editorRef]);
  useEffect(() => {
    mounted.current = true;
    editor.focus(() => editor.update(() => $getRoot().selectStart()));
    function removeImage(event: KeyboardEvent) {
      const s = $getSelection();
      if (!$isNodeSelection(s)) return false;
      const images = s.getNodes().filter((n) => n instanceof ComposeImageNode);
      if (!images.length) return false;
      event.preventDefault();
      images.forEach((n) => n.remove());
      return true;
    }
    const unregister = mergeRegister(
      editor.registerUpdateListener(
        ({ editorState, dirtyElements, dirtyLeaves }) => {
          if (!dirtyElements.size && !dirtyLeaves.size) return;
          try {
            onChange(
              validateRichDocument({
                version: 1,
                editor: JSON.parse(JSON.stringify(editorState.toJSON())),
              }),
            );
            onValidation(true);
          } catch {
            onValidation(false);
            onError(
              "Message formatting or size exceeds supported limits. Undo the last change.",
            );
          }
        },
      ),
      editor.registerCommand(
        KEY_DELETE_COMMAND,
        removeImage,
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_BACKSPACE_COMMAND,
        removeImage,
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_DOWN_COMMAND,
        (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
            e.preventDefault();
            const selection = $getSelection()?.clone() ?? null;
            // Show the modal after Lexical commits this keyboard selection.
            queueMicrotask(() => editLink(editor, onError, selection));
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        DROP_COMMAND,
        (event) => {
          if (!event.dataTransfer || event.dataTransfer.files.length)
            return false;
          event.preventDefault();
          $insertClipboardContent(event.dataTransfer, onError);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          if (!(event instanceof ClipboardEvent) || !event.clipboardData)
            return false;
          event.preventDefault();
          const files = Array.from(event.clipboardData.files);
          if (files.length) {
            void insertFiles(editor, files, upload, onError, mounted);
            return true;
          }
          $insertClipboardContent(event.clipboardData, onError);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    );
    return () => {
      mounted.current = false;
      unregister();
    };
  }, [editor, onChange, onError, onValidation, upload]);
  return null;
}
async function insertFiles(
  editor: LexicalEditor,
  files: File[],
  upload: Upload,
  onError: (message: string) => void,
  mounted: React.RefObject<boolean>,
) {
  let selection: ReturnType<typeof $getSelection> = null;
  editor.getEditorState().read(() => {
    selection = $getSelection()?.clone() ?? null;
  });
  for (const file of files) {
    const inline = [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/avif",
    ].includes(file.type);
    const a = await upload(file, inline);
    if (!a || !inline || !mounted.current) continue;
    try {
      editor.update(() => {
        try {
          if (
            selection &&
            (!$isRangeSelection(selection) ||
              ($getNodeByKey(selection.anchor.key) &&
                $getNodeByKey(selection.focus.key)))
          )
            $setSelection(selection);
          else $getRoot().selectEnd();
        } catch {
          $getRoot().selectEnd();
        }
        $insertNodes([
          new ComposeImageNode({
            type: "maildock-image",
            version: 1,
            resourceId: a.id,
            alt: file.name || "Pasted image",
            width: 480,
          }),
        ]);
        selection = $getSelection()?.clone() ?? null;
      });
    } catch {
      onError("Image uploaded but could not be inserted. Remove it and retry.");
    }
  }
}
export function RichComposer({
  initialDocument,
  onChange,
  onError,
  onValidation,
  upload,
  disabled,
  draftId,
  revision,
  signatureOptions,
}: {
  initialDocument: RichDocument;
  onChange: (doc: RichDocument) => void;
  onError: (message: string) => void;
  onValidation: (valid: boolean) => void;
  upload: Upload;
  disabled: boolean;
  draftId: string;
  revision: number;
  signatureOptions?: ComposeSignatureOptions;
}) {
  const editorRef = useRef<LexicalEditor | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A stable extension owns one editor for the whole draft session. Autosave and
  // parent rerenders must never recreate it or clear selection/undo history.
  const [extension] = useState(() =>
    defineExtension({
      name: "MaildockComposeV1",
      namespace: "MaildockComposeV1",
      nodes: () => [ComposeImageNode, AutomaticSignatureNode],
      dependencies: [
        RichTextExtension,
        configExtension(HistoryExtension, { delay: 1000 }),
        ListExtension,
        configExtension(LinkExtension, {
          validateUrl: validateLinkUrl,
          attributes: { rel: null, target: null, title: null },
        }),
        configExtension(TableExtension, {
          hasCellBackgroundColor: false,
          hasHorizontalScroll: true,
        }),
        HorizontalRuleExtension,
      ],
      $initialEditorState: JSON.stringify(
        validateRichDocument(initialDocument).editor,
      ),
      editable: !disabled,
      onError: () =>
        onError(
          "The editor could not apply this change. Undo or reopen the saved draft.",
        ),
      theme: {
        text: {
          bold: "rich-bold",
          italic: "rich-italic",
          underline: "rich-underline",
          strikethrough: "rich-strike",
          underlineStrikethrough: "rich-underline-strike",
        },
        paragraph: "rich-paragraph",
        quote: "rich-quote",
        table: "rich-table",
        tableScrollableWrapper: "rich-table-scroll",
        tableCell: "rich-cell",
        list: { ul: "rich-ul", ol: "rich-ol" },
      },
    }),
  );
  return (
    <PreviewContext.Provider value={{ draftId, revision }}>
      <LexicalExtensionComposer extension={extension} contentEditable={null}>
        <Toolbar
          disabled={disabled}
          onError={onError}
          signatureOptions={signatureOptions}
          draftId={draftId}
        />
        <div
          className="rich-editor-container"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length || !editorRef.current || disabled)
              return;
            e.preventDefault();
            e.stopPropagation();
            // Native caret placement uses the browser's actual drop point.
            const doc = document as Document & {
              caretRangeFromPoint?: (x: number, y: number) => Range | null;
              caretPositionFromPoint?: (
                x: number,
                y: number,
              ) => { offsetNode: Node; offset: number } | null;
            };
            const range = doc.caretRangeFromPoint?.(e.clientX, e.clientY);
            const position = !range
              ? doc.caretPositionFromPoint?.(e.clientX, e.clientY)
              : null;
            const target = range?.startContainer ?? position?.offsetNode;
            const offset = range?.startOffset ?? position?.offset ?? 0;
            if (
              target &&
              editorRef.current.getRootElement()?.contains(target)
            ) {
              editorRef.current.update(
                () => {
                  const node = $getNearestNodeFromDOMNode(target);
                  if ($isTextNode(node) || $isElementNode(node)) {
                    const selection = $createRangeSelection();
                    const type = $isTextNode(node) ? "text" : "element";
                    const bounded = Math.min(
                      offset,
                      $isTextNode(node)
                        ? node.getTextContentSize()
                        : node.getChildrenSize(),
                    );
                    selection.anchor.set(node.getKey(), bounded, type);
                    selection.focus.set(node.getKey(), bounded, type);
                    $setSelection(selection);
                  } else node?.getParent()?.selectEnd();
                },
                { discrete: true },
              );
            }
            void insertFiles(
              editorRef.current,
              Array.from(e.dataTransfer.files),
              upload,
              onError,
              mounted,
            );
          }}
        >
          <ContentEditable className="rich-editor" aria-label="Message body" />
        </div>
        <Behavior
          editorRef={editorRef}
          disabled={disabled}
          onChange={onChange}
          onError={onError}
          onValidation={onValidation}
          upload={upload}
        />
      </LexicalExtensionComposer>
    </PreviewContext.Provider>
  );
}
