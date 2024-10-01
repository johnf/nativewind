import { debug as debugFn } from "debug";
import {
  KeyframesRule,
  Animation,
  Declaration,
  EasingFunction,
  transform as lightningcss,
  DeclarationBlock,
  MediaQuery,
  MediaRule,
  SelectorList,
  Rule,
  ContainerType,
  ContainerRule,
} from "lightningcss";

import {
  AnimatableCSSProperty,
  ExtractedAnimation,
  ExtractionWarning,
  ExtractRuleOptions,
  CssToReactNativeRuntimeOptions,
  StyleSheetRegisterCompiledOptions,
  StyleRule,
  Specificity,
  MoveTokenRecord,
  StyleRuleSet,
  StyleDeclaration,
  PathTokens,
  AnimationFrame,
  RuntimeValueDescriptor,
  SpecificityValue,
} from "../types";
import { ParseDeclarationOptions, parseDeclaration } from "./parseDeclaration";
import {
  DEFAULT_CONTAINER_NAME,
  isRuntimeDescriptor,
  SpecificityIndex,
} from "../shared";
import { normalizeSelectors, toRNProperty } from "./normalize-selectors";
import { optimizeRules } from "./optimize-rules";

import { versions } from "node:process";
import { defaultFeatureFlags } from "./feature-flags";

type CSSInteropAtRule = {
  type: "custom";
  value: {
    name: string;
    prelude: { value: { components: Array<{ value: string }> } };
  };
};

export type { CssToReactNativeRuntimeOptions };

/**
 * Converts a CSS file to a collection of style declarations that can be used with the StyleSheet API
 *
 * @param {Buffer|string} code - The CSS file contents
 * @param {CssToReactNativeRuntimeOptions} options - (Optional) Options for the conversion process
 * @returns {StyleSheetRegisterOptions} - An object containing the extracted style declarations and animations
 */
export function cssToReactNativeRuntime(
  code: Buffer | string,
  {
    debug = debugFn("react-native-css-interop"),
    ...options
  }: CssToReactNativeRuntimeOptions = {},
): StyleSheetRegisterCompiledOptions {
  const features = Object.assign({}, defaultFeatureFlags, options.features);

  debug(`Features ${JSON.stringify(features)}`);

  if (Number(versions.node.split(".")[0]) < 18) {
    throw new Error("react-native-css-interop only supports NodeJS >18");
  }

  // Parse the grouping options to create an array of regular expressions
  const grouping =
    options.grouping?.map((value) => {
      return typeof value === "string" ? new RegExp(value) : value;
    }) ?? [];

  debug(`Grouping ${grouping}`);

  // These will by mutated by `extractRule`
  const extractOptions: ExtractRuleOptions = {
    darkMode: { type: "media" },
    rules: new Map(),
    keyframes: new Map(),
    rootVariables: {},
    universalVariables: {},
    flags: {},
    appearanceOrder: 1,
    ...options,
    features,
    grouping,
  };

  debug(`Start lightningcss`);

  // Use the lightningcss library to traverse the CSS AST and extract style declarations and animations
  lightningcss({
    filename: "style.css", // This is ignored, but required
    code: typeof code === "string" ? new TextEncoder().encode(code) : code,
    visitor: {
      StyleSheetExit(sheet) {
        debug(`StyleSheetExit`);

        for (const rule of sheet.rules) {
          // Extract the style declarations and animations from the current rule
          extractRule(rule, extractOptions);
          // We have processed this rule, so now delete it from the AST
        }

        debug(`Extraction of ${sheet.rules.length} rules finished`);
      },
    },
    customAtRules: {
      cssInterop: {
        prelude: "<custom-ident>+",
      },
      "rn-move": {
        prelude: "<custom-ident>+",
      },
    },
  });

  debug("Start optimizing rules");
  let rules: StyleSheetRegisterCompiledOptions["rules"] = [];
  for (const [name, styles] of extractOptions.rules) {
    if (styles.length === 0) continue;

    const styleRuleSet: StyleRuleSet = { $type: "StyleRuleSet" };

    for (const { warnings, ...style } of styles) {
      if (style.s[SpecificityIndex.Important]) {
        styleRuleSet.important ??= [];
        styleRuleSet.important.push(style);
      } else {
        styleRuleSet.normal ??= [];
        styleRuleSet.normal.push(style);
      }

      if (warnings) {
        styleRuleSet.warnings ??= [];
        styleRuleSet.warnings.push(...warnings);
      }

      if (style.variables) styleRuleSet.variables = true;
      if (style.container) styleRuleSet.container = true;
      if (style.animations) styleRuleSet.animation = true;
      if (style.transition) styleRuleSet.animation = true;
      if (style.pseudoClasses?.active) styleRuleSet.active = true;
      if (style.pseudoClasses?.hover) styleRuleSet.hover = true;
      if (style.pseudoClasses?.focus) styleRuleSet.focus = true;
    }

    rules.push([name, styleRuleSet]);
  }

  rules = optimizeRules(rules);
  debug("Finishing optimization");
  debug(`Rule set count: ${rules?.length || 0}`);

  // Convert the extracted style declarations and animations from maps to objects and return them
  return {
    $compiled: true,
    rules,
    keyframes: Array.from(extractOptions.keyframes.entries()),
    rootVariables: extractOptions.rootVariables,
    universalVariables: extractOptions.universalVariables,
    flags: extractOptions.flags,
    rem: extractOptions.rem,
  };
}

/**
 * Extracts style declarations and animations from a given CSS rule, based on its type.
 *
 * @param {Rule} rule - The CSS rule to extract style declarations and animations from.
 * @param {ExtractRuleOptions} extractOptions - Options for the extraction process, including maps for storing extracted data.
 * @param {CssToReactNativeRuntimeOptions} parseOptions - Options for parsing the CSS code, such as grouping related rules together.
 */
function extractRule(
  rule: Rule | CSSInteropAtRule,
  extractOptions: ExtractRuleOptions,
  partialStyle: Partial<StyleRule> = {},
) {
  // Check the rule's type to determine which extraction function to call
  switch (rule.type) {
    case "keyframes": {
      // If the rule is a keyframe animation, extract it with the `extractKeyFrames` function
      extractKeyFrames(rule.value, extractOptions);
      break;
    }
    case "container": {
      // If the rule is a container, extract it with the `extractedContainer` function
      extractedContainer(rule.value, extractOptions);
      break;
    }
    case "media": {
      // If the rule is a media query, extract it with the `extractMedia` function
      extractMedia(rule.value, extractOptions);
      break;
    }
    case "style": {
      // If the rule is a style declaration, extract it with the `getExtractedStyle` function and store it in the `declarations` map
      if (rule.value.declarations) {
        for (const style of getExtractedStyles(
          rule.value.declarations,
          extractOptions,
          getRnMoveMapping(rule.value.rules),
        )) {
          setStyleForSelectorList(
            { ...partialStyle, ...style },
            rule.value.selectors,
            extractOptions,
          );
        }
        extractOptions.appearanceOrder++;
      }
      break;
    }
    case "custom": {
      if (rule.value && rule.value?.name === "cssInterop") {
        extractCSSInteropFlag(rule, extractOptions);
      }
    }
  }
}

/**
 * @rn-move is a custom at-rule that allows you to move a style property to a different prop/location
 * Its a placeholder concept until we improve the LightningCSS parsing
 */
function getRnMoveMapping<D, M>(rules?: any[]): MoveTokenRecord {
  if (!rules) return {};
  const mapping: MoveTokenRecord = {};

  for (const rule of rules) {
    if (rule.type !== "custom" && rule.value.name !== "rn-move") continue;

    /**
     * - is a special character that indicates that the style should be hoisted
     * Otherwise, keep it on the 'style' prop
     */
    let [first, tokens] = rule.value.prelude.value.components.map(
      (c: any) => c.value,
    );

    if (tokens) {
      if (tokens.startsWith("&")) {
        mapping[toRNProperty(first)] = [
          "style",
          ...tokens.replace("&", "").split(".").map(toRNProperty),
        ];
      } else {
        mapping[toRNProperty(first)] = tokens.split(".").map(toRNProperty);
      }
    } else {
      if (first.startsWith("&")) {
        mapping["*"] = ["style", toRNProperty(first.replace("&", ""))];
      } else {
        mapping["*"] = [toRNProperty(first)];
      }
    }
  }

  return mapping;
}

function extractCSSInteropFlag(
  rule: CSSInteropAtRule,
  extractOptions: ExtractRuleOptions,
) {
  if (rule.value.prelude.value.components[0].value !== "set") {
    return;
  }
  const [_, name, type, ...other] = rule.value.prelude.value.components.map(
    (c) => c.value,
  );

  if (name === "darkMode") {
    let value: string | undefined;

    if (other.length === 0 || other[0] === "media") {
      extractOptions.darkMode = { type: "media" };
    } else {
      value = other[0];

      if (value.startsWith(".")) {
        value = value.slice(1);
        extractOptions.darkMode = { type: "class", value };
      } else if (value.startsWith("[")) {
        extractOptions.darkMode = { type: "attribute", value };
      } else if (value === "dark") {
        extractOptions.darkMode = { type: "class", value };
      }
    }
    extractOptions.flags.darkMode = `${type} ${value}`.trim();
  } else {
    const value = other.length === 0 ? "true" : other;
    extractOptions.flags[name] = value;
  }
}

/**
 * This function takes in a MediaRule object, an ExtractRuleOptions object and a CssToReactNativeRuntimeOptions object,
 * and returns an array of MediaQuery objects representing styles extracted from screen media queries.
 *
 * @param mediaRule - The MediaRule object containing the media query and its rules.
 * @param extractOptions - The ExtractRuleOptions object to use when extracting styles.
 * @param parseOptions - The CssToReactNativeRuntimeOptions object to use when parsing styles.
 *
 * @returns undefined if no screen media queries are found in the mediaRule, else it returns the extracted styles.
 */
function extractMedia(
  mediaRule: MediaRule,
  extractOptions: ExtractRuleOptions,
) {
  // Initialize an empty array to store screen media queries
  const media: MediaQuery[] = [];

  // Iterate over all media queries in the mediaRule
  for (const mediaQuery of mediaRule.query.mediaQueries) {
    if (
      // If this is only a media query
      (mediaQuery.mediaType === "print" && mediaQuery.qualifier !== "not") ||
      // If this is a @media not print {}
      // We can only do this if there are no conditions, as @media not print and (min-width: 100px) could be valid
      (mediaQuery.mediaType !== "print" &&
        mediaQuery.qualifier === "not" &&
        mediaQuery.condition === null)
    ) {
      continue;
    }

    media.push(mediaQuery);
  }

  if (media.length === 0) {
    return;
  }

  // Iterate over all rules in the mediaRule and extract their styles using the updated ExtractRuleOptions
  for (const rule of mediaRule.rules) {
    extractRule(rule, extractOptions, { media });
  }
}

/**
 * @param containerRule - The ContainerRule object containing the container query and its rules.
 * @param extractOptions - The ExtractRuleOptions object to use when extracting styles.
 * @param parseOptions - The CssToReactNativeRuntimeOptions object to use when parsing styles.
 */
function extractedContainer(
  containerRule: ContainerRule,
  extractOptions: ExtractRuleOptions,
) {
  // Iterate over all rules inside the containerRule and extract their styles using the updated ExtractRuleOptions
  for (const rule of containerRule.rules) {
    extractRule(rule, extractOptions, {
      containerQuery: [
        {
          name: containerRule.name,
          condition: containerRule.condition,
        },
      ],
    });
  }
}

/**
 * @param style - The ExtractedStyle object to use when setting styles.
 * @param selectorList - The SelectorList object containing the selectors to use when setting styles.
 * @param declarations - The declarations object to use when adding declarations.
 */
function setStyleForSelectorList(
  extractedStyle: StyleRule,
  selectorList: SelectorList,
  options: ExtractRuleOptions,
) {
  const { rules: declarations } = options;

  for (const selector of normalizeSelectors(
    extractedStyle,
    selectorList,
    options,
  )) {
    const style: StyleRule = { ...extractedStyle };
    if (!style.declarations) continue;

    if (
      selector.type === "rootVariables" || // :root
      selector.type === "universalVariables" // *
    ) {
      const fontSizeValue = style.declarations.findLast(([value, property]) => {
        if (property === "fontSize" && typeof value === "number") {
          return true;
        }
      })?.[0];

      if (typeof fontSizeValue === "number") {
        options.rem = fontSizeValue;
      }

      if (!style.variables) {
        continue;
      }

      const { type, subtype } = selector;
      const record = (options[type] ??= {});
      for (const [name, value] of style.variables) {
        record[name] ??= {};
        record[name][subtype] = value as any;
      }
      continue;
    } else if (selector.type === "className") {
      const {
        className,
        groupClassName,
        pseudoClasses,
        groupPseudoClasses,
        attrs,
        groupAttrs,
        media,
      } = selector;

      const specificity: SpecificityValue[] = [];
      for (let index = 0; index < 5; index++) {
        const value =
          (extractedStyle.s[index] ?? 0) + (selector.specificity[index] ?? 0);
        if (value) {
          specificity[index] = value;
        }
      }

      if (groupClassName) {
        // Add the conditions to the declarations object
        addDeclaration(declarations, groupClassName, {
          $type: "StyleRule",
          s: specificity,
          attrs,
          declarations: [],
          container: {
            names: [groupClassName],
          },
        });

        style.containerQuery ??= [];
        style.containerQuery.push({
          name: groupClassName,
          pseudoClasses: groupPseudoClasses,
          attrs: groupAttrs,
        });
      }

      if (media) {
        style.media ??= [];
        style.media.push(...media);
      }

      addDeclaration(declarations, className, {
        ...style,
        s: specificity,
        pseudoClasses,
        attrs,
      });
    }
  }
}

function addDeclaration(
  declarations: ExtractRuleOptions["rules"],
  className: string,
  style: StyleRule,
) {
  const existing = declarations.get(className);
  if (existing) {
    existing.push(style);
  } else {
    declarations.set(className, [style]);
  }
}

function extractKeyFrames(
  keyframes: KeyframesRule<Declaration>,
  extractOptions: ExtractRuleOptions,
) {
  const animation: ExtractedAnimation = { frames: [] };
  let rawFrames: Array<{
    selector: number;
    values: StyleDeclaration[];
    easingFunction?: EasingFunction;
  }> = [];

  for (const frame of keyframes.keyframes) {
    if (!frame.declarations.declarations) continue;

    const specificity: Specificity = [];
    specificity[SpecificityIndex.Important] = 2; // Animations have higher specificity than important
    specificity[SpecificityIndex.ClassName] = 1;
    specificity[SpecificityIndex.Order] = extractOptions.appearanceOrder;

    const { declarations, animations } = declarationsToStyle(
      frame.declarations.declarations,
      {
        ...extractOptions,
        requiresLayout(name) {
          if (name === "rnw") {
            animation.requiresLayoutWidth = true;
          } else {
            animation.requiresLayoutHeight = true;
          }
        },
      },
      specificity,
      {},
    );

    if (!declarations) continue;

    /**
     * We an only animation style props
     * Non-style props have pathTokens instead of a single string
     */
    const values = declarations.filter(
      (declaration) => typeof declaration[1] === "string",
    );

    if (values.length === 0) continue;

    const easingFunction = animations?.timingFunction?.[0];

    for (const selector of frame.selectors) {
      const keyframe =
        selector.type === "percentage"
          ? selector.value * 100
          : selector.type === "from"
            ? 0
            : selector.type === "to"
              ? 100
              : undefined;

      if (keyframe === undefined) continue;

      switch (selector.type) {
        case "percentage":
          rawFrames.push({ selector: selector.value, values, easingFunction });
          break;
        case "from":
          rawFrames.push({ selector: 0, values, easingFunction });
          break;
        case "to":
          rawFrames.push({ selector: 1, values, easingFunction });
          break;
        case "timeline-range-percentage":
          break;
        default:
          selector satisfies never;
      }
    }
  }

  // Need to sort afterwards, as the order of the frames is not guaranteed
  rawFrames = rawFrames.sort((a, b) => a.selector - b.selector);

  // Convert the rawFrames into frames
  const frames: Record<string, AnimationFrame> = {};

  const easingFunctions: EasingFunction[] = [];

  for (let i = 0; i < rawFrames.length; i++) {
    const rawFrame = rawFrames[i];
    const animationProgress = rawFrame.selector;
    const previousProgress = i === 0 ? 0 : rawFrames[i - 1].selector;
    const progress = animationProgress - previousProgress;

    if (rawFrame.easingFunction) {
      easingFunctions[i] = rawFrame.easingFunction;
    }

    for (const frameValue of rawFrame.values) {
      const [value, propOrPathTokens] = Array.isArray(frameValue)
        ? frameValue
        : [frameValue];

      // We only accept animations on the `style` prop
      if (Array.isArray(propOrPathTokens) || !propOrPathTokens) {
        continue;
      }

      const key = propOrPathTokens;

      if (!isRuntimeDescriptor(value)) {
        throw new Error("animation is an object?");
      }

      if (!frames[key]) {
        frames[key] = [key, []];
      }

      // All props need a progress 0 frame
      if (progress !== 0 && frames[key][1].length === 0) {
        frames[key][1].push({ value: "!INHERIT!", progress: 0 });
      }

      frames[key][1].push({ value, progress });
    }
  }

  animation.frames = Object.values(frames);

  if (easingFunctions.length) {
    // This is a holey array and may contain undefined values
    animation.easingFunctions = Array.from<EasingFunction | undefined>(
      easingFunctions,
    ).map((value) => {
      return value ?? { type: "!PLACEHOLDER!" };
    });
  }

  extractOptions.keyframes.set(keyframes.name.value, animation);
}

interface GetExtractedStyleOptions extends ExtractRuleOptions {
  requiresLayout?: (name: string) => void;
}

function getExtractedStyles(
  declarationBlock: DeclarationBlock<Declaration>,
  options: GetExtractedStyleOptions,
  mapping: MoveTokenRecord = {},
): StyleRule[] {
  const extractedStyles = [];

  const specificity: Specificity = [];
  specificity[SpecificityIndex.Order] = options.appearanceOrder;

  if (declarationBlock.declarations && declarationBlock.declarations.length) {
    extractedStyles.push(
      declarationsToStyle(
        declarationBlock.declarations,
        options,
        specificity,
        mapping,
      ),
    );
  }

  if (
    declarationBlock.importantDeclarations &&
    declarationBlock.importantDeclarations.length
  ) {
    specificity[SpecificityIndex.Important] = 1;
    extractedStyles.push(
      declarationsToStyle(
        declarationBlock.importantDeclarations,
        options,
        specificity,
        mapping,
      ),
    );
  }

  return extractedStyles;
}

function declarationsToStyle(
  declarations: Declaration[],
  options: GetExtractedStyleOptions,
  specificity: Specificity,
  mapping: MoveTokenRecord,
): StyleRule {
  const props: StyleDeclaration[] = [];
  const extractedStyle: StyleRule = {
    $type: "StyleRule",
    s: [...specificity],
    declarations: props,
  };

  /*
   * Adds a style property to the rule record.
   *
   * The shorthand option handles if the style came from a long or short hand property
   * E.g. `margin` is a shorthand property for `margin-top`, `margin-bottom`, `margin-left` and `margin-right`
   *
   * The `append` option allows the same property to be added multiple times
   * E.g. `transform` accepts an array of transforms
   */
  function addStyleProp(
    attribute: string,
    value: RuntimeValueDescriptor,
    moveTokens?: PathTokens,
  ) {
    if (value === undefined) {
      return;
    }

    if (attribute.startsWith("--")) {
      return addVariable(attribute, value);
    }

    attribute = toRNProperty(attribute);

    const attributeMapping: PathTokens | undefined =
      mapping[attribute] ?? mapping["*"];

    const shouldDelay = Array.isArray(value) && Boolean(value[3]);

    const pathTokens =
      !moveTokens && !attributeMapping
        ? attribute
        : [...(moveTokens || []), ...(attributeMapping || [])];

    if (typeof pathTokens === "string") {
      if (shouldDelay) {
        props.push([value, pathTokens, true]);
      } else {
        props.push([value, pathTokens]);
      }
    } else {
      if (shouldDelay) {
        props.push([value, pathTokens, true]);
      } else {
        props.push([value, pathTokens]);
      }
    }
  }

  function addTransformProp(property: string, value: any) {
    return addStyleProp(property, value);
  }

  function handleTransformShorthand(
    name: string,
    options: Record<string, RuntimeValueDescriptor>,
  ) {
    if (allEqual(...Object.values(options))) {
      return addStyleProp(name, Object.values(options)[0], ["transform", name]);
    } else {
      for (const [name, value] of Object.entries(options)) {
        addStyleProp(name, value, ["transform", name]);
      }
    }
  }

  function handleStyleShorthand(
    name: string,
    options: Record<string, RuntimeValueDescriptor>,
  ) {
    if (allEqual(...Object.values(options))) {
      return addStyleProp(name, Object.values(options)[0]);
    } else {
      for (const [name, value] of Object.entries(options)) {
        addStyleProp(name, value);
      }
    }
  }

  function addVariable(property: string, value: any) {
    extractedStyle.variables ??= [];
    extractedStyle.variables.push([property, value]);
  }

  function addContainerProp(
    declaration: Extract<
      Declaration,
      { property: "container" | "container-name" | "container-type" }
    >,
  ) {
    let names: false | string[] = [DEFAULT_CONTAINER_NAME];
    let type: ContainerType | undefined;

    switch (declaration.property) {
      case "container":
        if (declaration.value.name.type === "none") {
          names = false;
        } else {
          names = declaration.value.name.value;
        }
        type = declaration.value.containerType;
        break;
      case "container-name":
        if (declaration.value.type === "none") {
          names = false;
        } else {
          names = declaration.value.value;
        }
        break;
      case "container-type":
        type = declaration.value;
        break;
    }

    extractedStyle.container ??= {};

    if (names === false) {
      extractedStyle.container.names = false;
    } else if (Array.isArray(extractedStyle.container.names)) {
      extractedStyle.container.names = [
        ...new Set([...extractedStyle.container.names, ...names]),
      ];
    } else {
      extractedStyle.container.names = names;
    }

    if (type) {
      extractedStyle.container ??= {};
      extractedStyle.container.type = type;
    }
  }

  function addTransitionProp(
    declaration: Extract<
      Declaration,
      {
        property:
          | "transition-property"
          | "transition-duration"
          | "transition-delay"
          | "transition-timing-function"
          | "transition";
      }
    >,
  ) {
    extractedStyle.transition ??= {};

    switch (declaration.property) {
      case "transition-property":
        extractedStyle.transition.property = [];

        for (const v of declaration.value) {
          extractedStyle.transition.property.push(
            toRNProperty(v.property) as AnimatableCSSProperty,
          );
        }

        break;
      case "transition-duration":
        extractedStyle.transition.duration = declaration.value;
        break;
      case "transition-delay":
        extractedStyle.transition.delay = declaration.value;
        break;
      case "transition-timing-function":
        extractedStyle.transition.timingFunction = declaration.value;
        break;
      case "transition": {
        let setProperty = true;
        let setDuration = true;
        let setDelay = true;
        let setTiming = true;

        // Shorthand properties cannot override the longhand property
        // So we skip setting the property if it already exists
        // Otherwise, we need to set the property to an empty array
        if (extractedStyle.transition.property) {
          setProperty = false;
        } else {
          extractedStyle.transition.property = [];
        }
        if (extractedStyle.transition.duration) {
          setDuration = false;
        } else {
          extractedStyle.transition.duration = [];
        }
        if (extractedStyle.transition.delay) {
          setDelay = false;
        } else {
          extractedStyle.transition.delay = [];
        }
        if (extractedStyle.transition.timingFunction) {
          setTiming = false;
        } else {
          extractedStyle.transition.timingFunction = [];
        }

        // Loop through each transition value and only set the properties that
        // were not already set by the longhand property
        for (const value of declaration.value) {
          if (setProperty) {
            extractedStyle.transition.property?.push(
              toRNProperty(value.property.property) as AnimatableCSSProperty,
            );
          }
          if (setDuration) {
            extractedStyle.transition.duration?.push(value.duration);
          }
          if (setDelay) {
            extractedStyle.transition.delay?.push(value.delay);
          }
          if (setTiming) {
            extractedStyle.transition.timingFunction?.push(
              value.timingFunction,
            );
          }
        }
        break;
      }
    }
  }

  function addAnimationProp(property: string, value: any) {
    if (property === "animation") {
      const groupedProperties: Record<string, any[]> = {};

      for (const animation of value as Animation[]) {
        for (const [key, value] of Object.entries(animation)) {
          groupedProperties[key] ??= [];
          groupedProperties[key].push(value);
        }
      }

      extractedStyle.animations ??= {};
      for (const [property, value] of Object.entries(groupedProperties)) {
        const key = property
          .replace("animation-", "")
          .replace(/-./g, (x) => x[1].toUpperCase()) as keyof Animation;

        extractedStyle.animations[key] ??= value;
      }
    } else {
      const key = property
        .replace("animation-", "")
        .replace(/-./g, (x) => x[1].toUpperCase()) as keyof Animation;

      extractedStyle.animations ??= {};
      extractedStyle.animations[key] = value;
    }
  }

  function addWarning(warning: ExtractionWarning): undefined {
    const warningRegexArray = options.ignorePropertyWarningRegex;

    if (warningRegexArray) {
      const match = warningRegexArray.some((regex) =>
        new RegExp(regex).test(warning.property),
      );

      if (match) return;
    }

    extractedStyle.warnings ??= [];
    extractedStyle.warnings.push(warning);
  }

  function requiresLayout(name: string) {
    if (name === "rnw") {
      extractedStyle.requiresLayoutWidth = true;
    } else {
      extractedStyle.requiresLayoutHeight = true;
    }
  }

  const parseDeclarationOptions: ParseDeclarationOptions = {
    features: {},
    addStyleProp,
    addTransformProp,
    handleStyleShorthand,
    handleTransformShorthand,
    addAnimationProp,
    addContainerProp,
    addTransitionProp,
    requiresLayout,
    addWarning,
    ...options,
  };

  for (const declaration of declarations) {
    parseDeclaration(declaration, parseDeclarationOptions);
  }

  return extractedStyle;
}

function allEqual(...params: unknown[]) {
  return params.every((param, index, array) => {
    return index === 0 ? true : equal(array[0], param);
  });
}

function equal(a: unknown, b: unknown) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!equal(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    if (Object.keys(a).length !== Object.keys(b).length) return false;
    for (const key in a) {
      if (
        !equal(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        )
      )
        return false;
    }
    return true;
  }

  return false;
}
