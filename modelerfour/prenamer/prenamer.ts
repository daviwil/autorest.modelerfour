import { CodeModel, Parameter, isVirtualParameter, ObjectSchema, isObjectSchema, getAllParentProperties, Languages, SchemaType, Schema, ChoiceSchema, SealedChoiceSchema, GroupSchema, ImplementationLocation, Operation, Request, Response } from '@azure-tools/codemodel';
import { Session } from '@azure-tools/autorest-extension-base';
import { values, length, Dictionary, when, items } from '@azure-tools/linq';
import { removeSequentialDuplicates, fixLeadingNumber, deconstruct, selectName, Style, Styler, pascalCase } from '@azure-tools/codegen';

function getNameOptions(typeName: string, components: Array<string>) {
  const result = new Set<string>();

  // add a variant for each incrementally inclusive parent naming scheme.
  for (let i = 0; i < length(components); i++) {
    const subset = Style.pascal([...removeSequentialDuplicates(components.slice(-1 * i, length(components)))]);
    result.add(subset);
  }

  // add a second-to-last-ditch option as <typename>.<name>
  result.add(Style.pascal([...removeSequentialDuplicates([...fixLeadingNumber(deconstruct(typeName)), ...deconstruct(components.last)])]));
  return [...result.values()];
}

function isUnassigned(value: string) {
  return !value || (value.indexOf('·') > -1);
}

interface SetNameOptions {
  removeDuplicates: boolean
};

function setName(thing: { language: Languages }, styler: Styler, defaultValue: string, overrides: Dictionary<string>, options?: SetNameOptions) {
  options = {
    removeDuplicates: true,
    ...options
  };

  thing.language.default.name = styler(defaultValue && isUnassigned(thing.language.default.name) ? defaultValue : thing.language.default.name, options.removeDuplicates, overrides);
  if (!thing.language.default.name) {
    throw new Error('Name is empty!');
  }
}

function setNameAllowEmpty(thing: { language: Languages }, styler: Styler, defaultValue: string, overrides: Dictionary<string>, options?: SetNameOptions) {
  options = {
    removeDuplicates: true,
    ...options
  };

  thing.language.default.name = styler(defaultValue && isUnassigned(thing.language.default.name) ? defaultValue : thing.language.default.name, options.removeDuplicates, overrides);
}

/*
 * This function checks the `schemaNames` set for a proposed name for the
 * given `schema` using the `indexer` to generate the key to the set.  A
 * custom `indexer` would be used when there's a piece of information other
 * than the name itself to determine the uniqueness of the name (like a
 * namespace).
 */
function deduplicateSchemaName(
  schema: Schema,
  schemaNames: Set<string>,
  session: Session<CodeModel>,
  indexer: (schema: Schema, newName: string) => string =
    (schema: Schema, proposedName: string) => proposedName
): void {
  const schemaName = schema.language.default.name;
  const maxDedupes = 1000;
  if (schemaNames.has(indexer(schema, schemaName))) {
    for (let i = 1; i <= maxDedupes; i++) {
      const newName = `${schemaName}AutoGenerated${(i === 1 ? "" : i)}`;
      if (!schemaNames.has(indexer(schema, newName))) {
        schema.language.default.name = newName;
        schemaNames.add(indexer(schema, newName));
        session.warning(`Deduplicating schema name: '${schemaName}' -> '${newName}'`, ["PreNamer/DeduplicateName"]);
        return;
      }
    }

    session.error(`Attempted to deduplicate schema name '${schema.language.default.name}' more than ${maxDedupes} times and failed.`, ["PreNamer/DeduplicateName"])
  }

  // We haven't seen the name before, add it
  schemaNames.add(indexer(schema, schemaName));
}

export class PreNamer {
  codeModel: CodeModel
  options: Dictionary<any> = {};
  format = {
    parameter: Style.camel,
    property: Style.camel,
    operation: Style.pascal,
    operationGroup: Style.pascal,
    responseHeader: Style.pascal,
    choice: Style.pascal,
    choiceValue: Style.pascal,
    constant: Style.pascal,
    constantParameter: Style.camel,
    type: Style.pascal,
    client: Style.pascal,
    local: Style.camel,
    global: Style.pascal,
    override: <Dictionary<string>>{}
  }

  enum = 0;
  constant = 0;
  constructor(protected session: Session<CodeModel>) {
    this.codeModel = session.model;// shadow(session.model, filename);
  }

  async init() {
    // get our configuration for this run.
    this.options = await this.session.getValue('modelerfour', {});
    const naming = this.options.naming || {};
    const maxPreserve = Number(naming['preserve-uppercase-max-length']) || 3;
    this.format = {
      parameter: Style.select(naming.parameter, Style.camel, maxPreserve),
      property: Style.select(naming.property, Style.camel, maxPreserve),
      operation: Style.select(naming.operation, Style.pascal, maxPreserve),
      operationGroup: Style.select(naming.operationGroup, Style.pascal, maxPreserve),
      responseHeader: Style.select(naming.header, Style.pascal, maxPreserve),
      choice: Style.select(naming.choice, Style.pascal, maxPreserve),
      choiceValue: Style.select(naming.choiceValue, Style.pascal, maxPreserve),
      constant: Style.select(naming.constant, Style.pascal, maxPreserve),
      constantParameter: Style.select(naming.constantParameter, Style.camel, maxPreserve),
      client: Style.select(naming.client, Style.pascal, maxPreserve),
      type: Style.select(naming.type, Style.pascal, maxPreserve),
      local: Style.select(naming.local, Style.camel, maxPreserve),
      global: Style.select(naming.global, Style.pascal, maxPreserve),
      override: naming.override || {}
    }
    return this;
  }

  isUnassigned(value: string) {
    return !value || (value.indexOf('·') > -1);
  }

  process() {
    if (this.options['prenamer'] === false) {
      return this.codeModel;
    }

    const deduplicateSchemaNames =
      !!this.options['lenient-model-deduplication'] ||
      !!this.options['resolve-schema-name-collisons'];

    // choice
    const choiceSchemaNames = new Set<string>();
    for (const schema of values(this.codeModel.schemas.choices)) {
      setName(schema, this.format.choice, `Enum${this.enum++}`, this.format.override);

      if (deduplicateSchemaNames) {
        deduplicateSchemaName(schema, choiceSchemaNames, this.session);
      }

      for (const choice of values(schema.choices)) {
        setName(choice, this.format.choiceValue, '', this.format.override, { removeDuplicates: false });
      }
    }

    // sealed choice
    const sealedChoiceSchemaNames = new Set<string>();
    for (const schema of values(this.codeModel.schemas.sealedChoices)) {
      setName(schema, this.format.choice, `Enum${this.enum++}`, this.format.override);

      if (deduplicateSchemaNames) {
        deduplicateSchemaName(schema, sealedChoiceSchemaNames, this.session);
      }

      for (const choice of values(schema.choices)) {
        setName(choice, this.format.choiceValue, '', this.format.override, { removeDuplicates: false });
      }
    }

    // constant
    for (const schema of values(this.codeModel.schemas.constants)) {
      setName(schema, this.format.constant, `Constant${this.enum++}`, this.format.override);
    }

    // strings
    for (const schema of values(this.codeModel.schemas.strings)) {
      setName(schema, this.format.type, schema.type, this.format.override);
    }

    // number
    for (const schema of values(this.codeModel.schemas.numbers)) {
      setName(schema, this.format.type, schema.type, this.format.override);
    }

    for (const schema of values(this.codeModel.schemas.dates)) {
      setName(schema, this.format.type, schema.type, this.format.override);
    }
    for (const schema of values(this.codeModel.schemas.dateTimes)) {
      setName(schema, this.format.type, schema.type, this.format.override);
    }
    for (const schema of values(this.codeModel.schemas.durations)) {
      setName(schema, this.format.type, schema.type, this.format.override);
    }
    for (const schema of values(this.codeModel.schemas.uuids)) {
      setName(schema, this.format.type, schema.type, this.format.override);
    }

    for (const schema of values(this.codeModel.schemas.uris)) {
      setName(schema, this.format.type, schema.type, this.format.override);
    }

    for (const schema of values(this.codeModel.schemas.unixtimes)) {
      setName(schema, this.format.type, schema.type, this.format.override);

      if (isUnassigned(schema.language.default.description)) {
        schema.language.default.description = 'date in seconds since 1970-01-01T00:00:00Z.';
      }
    }

    for (const schema of values(this.codeModel.schemas.byteArrays)) {
      setName(schema, this.format.type, schema.type, this.format.override);
    }

    for (const schema of values(this.codeModel.schemas.chars)) {
      setName(schema, this.format.type, schema.type, this.format.override);
    }

    for (const schema of values(this.codeModel.schemas.booleans)) {
      setName(schema, this.format.type, schema.type, this.format.override);
    }

    for (const schema of values(this.codeModel.schemas.flags)) {
      setName(schema, this.format.type, schema.type, this.format.override);
    }

    // dictionary
    for (const schema of values(this.codeModel.schemas.dictionaries)) {
      setName(schema, this.format.type, `DictionaryOf${schema.elementType.language.default.name}`, this.format.override);
      if (isUnassigned(schema.language.default.description)) {
        schema.language.default.description = `Dictionary of ${schema.elementType.language.default.name}`;
      }
    }

    for (const schema of values(this.codeModel.schemas.arrays)) {
      setName(schema, this.format.type, `ArrayOf${schema.elementType.language.default.name}`, this.format.override);
      if (this.isUnassigned(schema.language.default.description)) {
        schema.language.default.description = `Array of ${schema.elementType.language.default.name}`;
      }
    }

    const objectSchemaNames = new Set<string>();
    for (const schema of values(this.codeModel.schemas.objects)) {
      setName(schema, this.format.type, '', this.format.override);

      if (deduplicateSchemaNames) {
        deduplicateSchemaName(
          schema,
          objectSchemaNames,
          this.session,
          (schema: Schema, proposedName: string) =>
            `${(schema.language.default.namespace || "")}.${proposedName}`);
      }

      for (const property of values(schema.properties)) {
        setName(property, this.format.property, '', this.format.override);
      }
    }

    const groupSchemaNames = new Set<string>();
    for (const schema of values(this.codeModel.schemas.groups)) {
      setName(schema, this.format.type, '', this.format.override);

      if (deduplicateSchemaNames) {
        deduplicateSchemaName(
          schema,
          groupSchemaNames,
          this.session,
          (schema: Schema, proposedName: string) =>
            `${(schema.language.default.namespace || "")}.${proposedName}`);
      }

      for (const property of values(schema.properties)) {
        setName(property, this.format.property, '', this.format.override);
      }
    }

    for (const parameter of values(this.codeModel.globalParameters)) {
      if (parameter.schema.type === SchemaType.Constant) {
        setName(parameter, this.format.constantParameter, '', this.format.override);
      } else {
        setName(parameter, this.format.parameter, '', this.format.override);
      }
    }

    for (const operationGroup of this.codeModel.operationGroups) {
      setNameAllowEmpty(operationGroup, this.format.operationGroup, operationGroup.$key, this.format.override, { removeDuplicates: false });
      for (const operation of operationGroup.operations) {
        setName(operation, this.format.operation, '', this.format.override);

        this.setParameterNames(operation);
        for (const request of values(operation.requests)) {
          this.setParameterNames(request);
        }

        for (const response of values(operation.responses)) {
          this.setResponseHeaderNames(response);
        }
        for (const response of values(operation.exceptions)) {
          this.setResponseHeaderNames(response);
        }

        const p = operation.language.default.paging;
        if (p) {
          p.group = p.group ? this.format.operationGroup(p.group, true, this.format.override) : undefined;
          p.member = p.member ? this.format.operation(p.member, true, this.format.override) : undefined;
        }
      }
    }

    // set a styled client name
    setName(this.codeModel, this.format.client, this.codeModel.info.title, this.format.override);

    // fix collisions from flattening on ObjectSchemas
    this.fixPropertyCollisions();

    // fix collisions from flattening on VirtualParameters
    this.fixParameterCollisions();

    return this.codeModel;
  }

  private setParameterNames(parameterContainer: Operation | Request) {
    for (const parameter of values(parameterContainer.signatureParameters)) {
      if (parameter.schema.type === SchemaType.Constant) {
        setName(parameter, this.format.constantParameter, '', this.format.override);
      }
      else {
        setName(parameter, this.format.parameter, '', this.format.override);
      }
    }
    for (const parameter of values(parameterContainer.parameters)) {
      if ((parameterContainer.signatureParameters ?? []).indexOf(parameter) === -1) {
        if (parameter.schema.type === SchemaType.Constant) {
          setName(parameter, this.format.constantParameter, '', this.format.override);
        }
        else {
          if (parameter.implementation === ImplementationLocation.Client) {
            setName(parameter, this.format.global, '', this.format.override);
          }
          else {
            setName(parameter, this.format.local, '', this.format.override);
          }
        }
      }
    }
  }

  private setResponseHeaderNames(response: Response) {
    if (response.protocol.http) {
      for (const { value: header } of items(response.protocol.http.headers)) {
        setName(header as {language: Languages}, this.format.responseHeader, '', this.format.override);
      }
    }
  }

  fixParameterCollisions() {
    for (const operation of values(this.codeModel.operationGroups).selectMany(each => each.operations)) {
      for (const request of values(operation.requests)) {
        const parameters = values(operation.signatureParameters).concat(values(request.signatureParameters));

        const usedNames = new Set<string>();
        const collisions = new Set<Parameter>();

        // we need to make sure we avoid name collisions. operation parameters get first crack.
        for (const each of values(parameters)) {
          const name = this.format.parameter(each.language.default.name);

          if (usedNames.has(name)) {
            collisions.add(each);
          } else {
            usedNames.add(name);
          }
        }

        // handle operation parameters
        for (const parameter of collisions) {
          let options = [parameter.language.default.name];
          if (isVirtualParameter(parameter)) {
            options = getNameOptions(parameter.schema.language.default.name, [parameter.language.default.name, ...parameter.pathToProperty.map(each => each.language.default.name)]).map(each => this.format.parameter(each));
          }
          parameter.language.default.name = this.format.parameter(selectName(options, usedNames));
        }
      }

    }

  }

  fixCollisions(schema: ObjectSchema) {
    for (const each of values(schema.parents?.immediate).where(each => isObjectSchema(each))) {
      this.fixCollisions(<ObjectSchema>each);
    }
    const [owned, flattened] = values(schema.properties).bifurcate(each => length(each.flattenedNames) === 0);
    const inherited = [...getAllParentProperties(schema)];

    const all = [...owned, ...inherited, ...flattened];

    const inlined = new Map<string, number>();
    for (const each of all) {
      const name = this.format.property(each.language.default.name);
      // track number of instances of a given name.
      inlined.set(name, (inlined.get(name) || 0) + 1);
    }

    const usedNames = new Set(inlined.keys());
    for (const each of flattened /*.sort((a, b) => length(a.nameOptions) - length(b.nameOptions)) */) {
      const ct = inlined.get(this.format.property(each.language.default.name));
      if (ct && ct > 1) {
        const options = getNameOptions(each.schema.language.default.name, [each.language.default.name, ...values(each.flattenedNames)]);
        each.language.default.name = this.format.property(selectName(options, usedNames));
      }
    }
  }

  fixPropertyCollisions() {
    for (const schema of values(this.codeModel.schemas.objects)) {
      this.fixCollisions(schema);
    }
  }
}
