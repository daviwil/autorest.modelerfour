/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from "assert";
import { suite, test } from "mocha-typescript";
import { ModelerFour } from "../../modeler/modelerfour";
import {
  createTestSession,
  createTestSpec,
  addSchema,
  addOperation,
  response,
  InitialTestSpec,
  responses
} from "./unitTestUtil";
import {
  CodeModel,
  Schema,
  SchemaUsage,
  ObjectSchema,
  OperationGroup,
  Operation,
  Parameter,
  SchemaResponse
} from "@azure-tools/codemodel";

const cfg = {
  modelerfour: {
    "flatten-models": true,
    "flatten-payloads": true,
    "group-parameters": true,
    "resolve-schema-name-collisons": true,
    "additional-checks": true,
    //'always-create-content-type-parameter': true,
    naming: {
      override: {
        $host: "$host",
        cmyk: "CMYK"
      },
      local: "_ + camel",
      constantParameter: "pascal"
    }
  },
  "payload-flattening-threshold": 2
};

async function runModeler(spec: any): Promise<CodeModel> {
  const modelerErrors: any[] = [];
  const session = await createTestSession(cfg, spec, modelerErrors);
  const modeler = await new ModelerFour(session).init();

  assert.equal(modelerErrors.length, 0);

  return modeler.process();
}

export function findByName<T>(
  name: string,
  items: T[] | undefined
): T | undefined {
  return (
    (items && items.find(i => (<any>i).language.default.name === name)) ||
    undefined
  );
}

function assertSchema(
  schemaName: string,
  schemaList: any[] | undefined,
  accessor: (schema: any) => any,
  expected: any
) {
  assert(
    schemaList,
    `Schema list was empty when searching for schema: ${schemaName}`
  );

  // We've already asserted, but make the compiler happy
  if (schemaList) {
    const schema = findByName(schemaName, schemaList);
    assert(schema, `Could not find schema in code model: ${schemaName}`);
    assert.deepEqual(accessor(schema), expected);
  }
}

@suite
class Modeler {
  @test
  async "preserves 'info' metadata"() {
    const spec = createTestSpec();
    const codeModel = await runModeler(spec);

    assert.strictEqual(codeModel.info.title, InitialTestSpec.info.title);
    assert.strictEqual(codeModel.info.license, InitialTestSpec.info.license);
    assert.strictEqual(
      codeModel.info.description,
      InitialTestSpec.info.description
    );
    assert.strictEqual(
      codeModel.info.contact?.name,
      InitialTestSpec.info.contact.name
    );
    assert.strictEqual(
      codeModel.info.contact?.url,
      InitialTestSpec.info.contact.url
    );
    assert.strictEqual(
      codeModel.info.contact?.email,
      InitialTestSpec.info.contact.email
    );
  }

  @test
  async "tracks schema usage"() {
    const testSchema = {
      type: "object",
      properties: {
        "prop-one": {
          type: "integer",
          format: "int32"
        }
      }
    };

    const spec = createTestSpec();

    addSchema(spec, "Input", {
      type: "object",
      properties: {
        arrayProperty: {
          type: "array",
          items: {
            $ref: "#/components/schemas/ElementSchema"
          }
        }
      }
    });
    addSchema(spec, "OutputItem", {
      type: "object",
      properties: {
        dictionaryProperty: {
          properties: {
            foo: {
              $ref: "#/components/schemas/ElementSchema"
            }
          }
        }
      }
    });
    addSchema(spec, "InputOutput", {
      type: "object",
      properties: {
        property: {
          $ref: "#/components/schemas/ObjectProperty"
        }
      }
    });
    addSchema(spec, "ObjectProperty", {
      type: "object",
      properties: {
        foo: {
          type: "string"
        }
      }
    });
    addSchema(spec, "ElementSchema", {
      type: "object",
      properties: {
        foo: {
          type: "string"
        }
      }
    });

    addOperation(spec, "/test", {
      get: {
        description: "An operation.",
        responses: responses(
          response(200, "application/json", {
            type: "array",
            items: {
              $ref: "#/components/schemas/OutputItem"
            }
          }),
          response(202, "application/xml", {
            $ref: "#/components/schemas/InputOutput"
          })
        )
      },
      post: {
        description: "Post it.",
        parameters: [
          {
            name: "inputParam",
            in: "body",
            description: "Input parameter",
            required: true,
            schema: {
              $ref: "#/components/schemas/Input"
            }
          },
          {
            name: "inputOutputParam",
            in: "body",
            description: "Input parameter",
            required: true,
            schema: {
              $ref: "#/components/schemas/InputOutput"
            }
          }
        ]
      }
    });

    const codeModel = await runModeler(spec);

    // Ensure that usage gets propagated to schemas in request parameters
    assertSchema("Input", codeModel.schemas.objects, s => s.usage, ["input"]);

    // Ensure that usage gets propagated to properties in response schemas
    assertSchema("OutputItem", codeModel.schemas.objects, s => s.usage, [
      "output"
    ]);

    // Ensure that usage gets propagated to schemas used in both request and response
    assertSchema(
      "InputOutput",
      codeModel.schemas.objects,
      s => s.usage.sort(),
      ["input", "output"]
    );

    // Ensure that usage gets propagated to schems on object properties
    assertSchema(
      "ObjectProperty",
      codeModel.schemas.objects,
      s => s.usage.sort(),
      ["input", "output"]
    );

    // Ensure that usage gets propagated to schemas used as elements of
    // arrays and dictionary property values
    assertSchema(
      "ElementSchema",
      codeModel.schemas.objects,
      s => s.usage.sort(),
      ["input", "output"]
    );
  }

  @test
  async "allows integer schemas with unexpected 'format'"() {
    const spec = createTestSpec();

    addSchema(spec, "Int16", {
      type: "integer",
      format: "int16"
    });

    addSchema(spec, "Goose", {
      type: "integer",
      format: "goose"
    });

    addSchema(spec, "Int64", {
      type: "integer",
      format: "int64"
    });

    const codeModel = await runModeler(spec);

    assertSchema("Int16", codeModel.schemas.numbers, s => s.precision, 32);
    assertSchema("Goose", codeModel.schemas.numbers, s => s.precision, 32);

    // Make sure a legitimate format is detected correctly
    assertSchema("Int64", codeModel.schemas.numbers, s => s.precision, 64);
  }

  @test
  async "modelAsString=true creates ChoiceSchema for single-value enum"() {
    const spec = createTestSpec();

    addSchema(spec, "ShouldBeConstant", {
      type: "string",
      enum: ["html_strip"]
    });

    addSchema(spec, "ShouldBeChoice", {
      type: "string",
      enum: ["html_strip"],
      "x-ms-enum": {
        modelAsString: true
      }
    });

    const codeModel = await runModeler(spec);

    assertSchema(
      "ShouldBeConstant",
      codeModel.schemas.constants,
      s => s.value.value,
      "html_strip"
    );

    assertSchema(
      "ShouldBeChoice",
      codeModel.schemas.choices,
      s => s.choices[0].value,
      "html_strip"
    );
  }

  @test
  async "propagates 'nullable' to properties, parameters, collections, and responses"() {
    const spec = createTestSpec();

    addSchema(spec, "WannaBeNullable", {
      type: "object",
      nullable: true,
      properties: {
        iIsHere: {
          type: "boolean"
        }
      }
    });

    addSchema(spec, "NullableArray", {
      type: "array",
      items: {
        $ref: "#/components/schemas/WannaBeNullable"
      }
    });

    addSchema(spec, "NullableDictionary", {
      additionalProperties: {
        $ref: "#/components/schemas/WannaBeNullable"
      }
    });

    addSchema(spec, "NullableProperty", {
      type: "object",
      properties: {
        willBeNullable: {
          $ref: "#/components/schemas/WannaBeNullable"
        }
      }
    });

    addOperation(spec, "/test", {
      post: {
        description: "Post it.",
        parameters: [
          {
            name: "nullableParam",
            in: "body",
            description: "Input parameter",
            required: true,
            schema: {
              $ref: "#/components/schemas/WannaBeNullable"
            }
          }
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "string",
                  nullable: true
                }
              }
            }
          }
        }
      }
    });

    const codeModel = await runModeler(spec);

    assertSchema(
      "NullableArray",
      codeModel.schemas.arrays,
      s => s.nullableItems,
      true
    );

    assertSchema(
      "NullableDictionary",
      codeModel.schemas.dictionaries,
      s => s.nullableItems,
      true
    );

    assertSchema(
      "NullableProperty",
      codeModel.schemas.objects,
      s => s.properties[0].nullable,
      true
    );

    // $host param comes first then the parameter we're looking for
    const operation = codeModel.operationGroups[0].operations[0];
    const param = operation.parameters![1];
    const response: SchemaResponse = <SchemaResponse>operation.responses![0];
    assert.strictEqual(param.nullable, true);
    assert.strictEqual(response.nullable, true);
  }

  @test
  async "propagates clientDefaultValue from x-ms-client-default"() {
    const spec = createTestSpec();

    addSchema(spec, "HasClientDefault", {
      type: "object",
      nullable: true,
      properties: {
        hasDefaultValue: {
          type: "boolean",
          required: true,
          "x-ms-client-default": true
        }
      }
    });

    addOperation(spec, "/test", {
      post: {
        operationId: "postIt",
        description: "Post it.",
        requestBody: {
          in: "body",
          description: "Input parameter",
          required: true,
          "x-ms-client-default": "Bodied",
          "x-ms-requestBody-name": "defaultedBodyParam",
          content: {
            "application/json": {
              schema: {
                type: "string"
              }
            }
          }
        },
        parameters: [
          {
            name: "defaultedQueryParam",
            in: "query",
            description: "Input parameter",
            "x-ms-client-default": 42,
            schema: {
              type: "number"
            }
          }
        ]
      }
    });

    addOperation(spec, "/memes", {
      post: {
        operationId: "postMeme",
        description: "Gimmie ur memes.",
        requestBody: {
          description: "Input parameter",
          required: true,
          "x-ms-requestBody-name": "defaultedBodyMeme",
          "x-ms-client-default": "meme.jpg",
          content: {
            "image/jpeg": {
              schema: {
                type: "string",
                format: "binary"
              }
            }
          }
        }
      }
    });

    const codeModel = await runModeler(spec);

    assertSchema(
      "HasClientDefault",
      codeModel.schemas.objects,
      s => s.properties[0].clientDefaultValue,
      true
    );

    const postIt = findByName(
      "postIt",
      codeModel.operationGroups[0].operations
    );
    const bodyParam = findByName<Parameter | undefined>(
      "defaultedBodyParam",
      <Parameter[] | undefined>postIt!.requests?.[0].parameters
    );
    assert.strictEqual(bodyParam?.clientDefaultValue, "Bodied");

    const queryParam = findByName("defaultedQueryParam", postIt!.parameters);
    assert.strictEqual(queryParam!.clientDefaultValue, 42);

    const postMeme = findByName(
      "postMeme",
      codeModel.operationGroups[0].operations
    );
    const memeBodyParam = findByName<Parameter | undefined>(
      "defaultedBodyMeme",
      <Parameter[] | undefined>postMeme!.requests?.[0].parameters
    );
    assert.strictEqual(memeBodyParam?.clientDefaultValue, "meme.jpg");
  }
}
