import { CodeModel, Schema, ObjectSchema, SchemaType, Property, ParameterLocation, Operation, Parameter, VirtualParameter } from '@azure-tools/codemodel';
import { Session } from '@azure-tools/autorest-extension-base';
import { values, items, length, Dictionary, refCount, clone } from '@azure-tools/linq';
import { filterOutXDash } from '@azure-tools/openapi';

const xmsThreshold = 'x-ms-payload-flattening-threshold';
const xmsFlatten = 'x-ms-client-flatten';
const marker = 'x-ms-flattening';

function isObjectSchema(schema: Schema): schema is ObjectSchema {
  return schema.type === SchemaType.Object;
}

export class Flattener {
  codeModel: CodeModel
  options: Dictionary<any> = {};
  threshold: number = 0;
  recursePayload: boolean = false;

  constructor(protected session: Session<CodeModel>) {
    this.codeModel = session.model;// shadow(session.model, filename);
  }

  async init() {
    // get our configuration for this run.
    this.options = await this.session.getValue('modelerfour', {});
    this.threshold = await this.session.getValue('payload-flattening-threshold', 0);
    this.recursePayload = await this.session.getValue('recursive-payload-flattening', false);
    return this;
  }

  *getFlattenedParameters(property: Property, path: Array<Property> = []): Iterable<VirtualParameter> {
    if (property.readOnly) {
      // skip read-only properties
      return;
    }
    if (isObjectSchema(property.schema) && this.recursePayload === true) {
      for (const child of values((<ObjectSchema>property.schema).properties)) {
        yield* this.getFlattenedParameters(child, [...path, property]);
      }
    } else {
      yield new VirtualParameter(property.language.default.name, property.language.default.description, property.schema, property);
    }
    // ·
  }
  /** 
   * This flattens an operation's parameters (ie, takes the parameters from an operation and if they are objects will attempt to create inline versions of them)
   */
  flattenPayload(operation: Operation, parameter: Parameter, schema: ObjectSchema) {
    // hide the original parameter
    parameter.hidden = true;

    for (const property of values(schema.properties)) {
      if (property.readOnly) {
        // skip read-only properties
        continue;
      }
      for (const vp of this.getFlattenedParameters(property)) {
        operation.request.parameters?.push(vp);
      }
    }
  }

  /**
   * This will flatten models that are marked 'x-ms-client-flatten'
   * @param schema schema to recursively flatten
   */
  flattenSchema(schema: ObjectSchema) {
    const state = schema.extensions?.[marker];

    if (state === false) {
      // already done.
      return;
    }

    if (state === true) {
      // in progress.
      throw new Error(`Circular reference encountered during processing of x-ms-client flatten ('${schema.language.default.name}')`);
    }

    // hasn't started yet.
    schema.extensions = schema.extensions || {};
    schema.extensions[marker] = true;

    if (schema.properties) {
      for (const { key: index, value: property } of items(schema.properties).toArray().reverse()) {

        if (isObjectSchema(property.schema) && property.extensions?.[xmsFlatten]) {
          // first, ensure tha the child is pre-flattened
          this.flattenSchema(property.schema);


          // remove that property from the scheama
          schema.properties.splice(index, 1);

          // copy all of the properties from the child into this 
          // schema 
          for (const childProperty of values(property.schema.properties)) {
            schema.addProperty(new Property(childProperty.language.default.name, childProperty.language.default.description, childProperty.schema, {
              ...(<any>childProperty),
              flattenedNames: [property.serializedName, ...childProperty.flattenedNames ? childProperty.flattenedNames : [childProperty.serializedName]],
              required: property.required && childProperty.required
            }));
          }

          // remove the extension
          delete property.extensions[xmsFlatten];
          if (length(property.extensions) === 0) {
            delete property['extensions'];
          }
          // and mark the child class as 'do-not-generate' ?
          (property.schema.extensions = property.schema.extensions || {})['x-ms-flattened'] = true;
        }
      }
    }

    schema.extensions[marker] = false;
  }

  process() {
    // support 'x-ms-payload-flattening-threshold'  per-operation
    // support '--payload-flattening-threshold:X' global setting

    if (this.options['flatten-models'] !== false) {

      for (const schema of values(this.codeModel.schemas.objects)) {
        this.flattenSchema(schema);
      }

      let dirty = false;
      do {
        // reset on every pass
        dirty = false;
        // remove unreferenced models 
        for (const { key, value: schema } of items(this.codeModel.schemas.objects)) {
          if (schema.discriminatorValue || schema.discriminator) {
            // it's polymorphic -- I don't think we can remove this 
            continue;
          }

          if (schema.children?.all || schema.parents?.all) {
            // it's got either a parent or child schema. 
            continue;
          }

          if (refCount(this.codeModel, schema) === 1) {
            delete this.codeModel.schemas.objects?.[key];
            dirty = true;
          }
        }
      } while (dirty);
    }
    if (this.options['flatten-payloads'] !== false) {
      /**
       * BodyParameter Payload Flattening 
       *  
       * A body parameter is flattened (one level) when:
       * 
       *  - the body parameter schema is an object
       *  - the body parameter schema is not polymorphic (is this true?)
       *   
       * 
       * 
       *  and one of:
       *  - the body parameter has x-ms-client-flatten: true
       *  - the operation has x-ms-payload-flattening-threshold greater than zero and the property count in the body parameter is lessthan or equal to that.
       *  - the global configuration option payload-flattening-threshold is greater than zero and the property count in the body parameter is lessthan or equal to that
       * 
       */

      // flatten payloads

      for (const group of this.codeModel.operationGroups) {
        for (const operation of group.operations) {
          const body = values(operation.request.parameters).first(p => p.protocol.http?.in === ParameterLocation.Body);

          if (body && isObjectSchema(body.schema)) {
            let flattenOperationPayload = body?.extensions?.[xmsFlatten];
            if (flattenOperationPayload === false) {
              // told not to explicitly.
              continue;
            }

            const schema = <ObjectSchema>body.schema;
            if (!flattenOperationPayload) {
              const threshold = <number>operation.extensions?.[xmsThreshold] ?? this.threshold;
              if (threshold > 0) {
                // get the count of the (non-readonly) properties in the schema
                const properties = values(schema.properties).where(property => property.readOnly !== true).toArray();
                flattenOperationPayload = properties.length <= threshold;
              }
            }

            if (flattenOperationPayload) {
              this.flattenPayload(operation, body, schema);
            }
          }
        }
      }
    }

    // cleanup 
    for (const schema of values(this.codeModel.schemas.objects)) {
      if (schema.extensions) {
        delete schema.extensions[marker];
        delete schema.extensions['flattened'];
        if (length(schema.extensions) === 0) {
          delete schema['extensions'];
        }
      }
    }
    return this.codeModel;
  }
}