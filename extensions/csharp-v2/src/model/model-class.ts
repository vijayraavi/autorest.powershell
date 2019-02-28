/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { KnownMediaType, HeaderProperty, HeaderPropertyType, Property } from '@microsoft.azure/autorest.codemodel-v3';

import { camelCase, deconstruct, items, values } from '@microsoft.azure/codegen';
import { Access, Class, Constructor, Expression, ExpressionOrLiteral, Field, If, InitializedField, Method, Modifier, Namespace, OneOrMoreStatements, Parameter, Statements, System, TypeDeclaration, valueOf, Variable, ImplementedProperty } from '@microsoft.azure/codegen-csharp';
import { ClientRuntime } from '../clientruntime';
import { State } from '../generator';
import { EnhancedTypeDeclaration } from '../schema/extended-type-declaration';
import { ObjectImplementation } from '../schema/object';
import { implementIDictionary } from './idictionary';
import { ModelInterface } from './interface';
import { JsonSerializableClass } from './model-class-json';
import { XmlSerializableClass } from './model-class-xml';
import { ModelProperty, ModelField } from './property';
import { ProxyProperty, VirtualProperty } from './proxy-property';
import { Schema } from '../code-model';
import { runInThisContext } from 'vm';

export interface BackingField {
  field: Field;
  typeDeclaration: TypeDeclaration;
  className: string;
}

export class ModelClass extends Class implements EnhancedTypeDeclaration {
  deserializeFromContainerMember(mediaType: KnownMediaType, container: ExpressionOrLiteral, serializedName: string, defaultValue: Expression): Expression {
    return this.implementation.deserializeFromContainerMember(mediaType, container, serializedName, defaultValue);
  }
  deserializeFromNode(mediaType: KnownMediaType, node: ExpressionOrLiteral, defaultValue: Expression): Expression {
    return this.implementation.deserializeFromNode(mediaType, node, defaultValue);
  }
  serializeToNode(mediaType: KnownMediaType, value: ExpressionOrLiteral, serializedName: string): Expression {
    return this.implementation.serializeToNode(mediaType, value, serializedName);
  }

  /** emits an expression serialize this to a HttpContent */
  serializeToContent(mediaType: KnownMediaType, value: ExpressionOrLiteral): Expression {
    return this.implementation.serializeToContent(mediaType, value);
  }

  /** emits an expression to deserialize content from a string */
  deserializeFromString(mediaType: KnownMediaType, content: ExpressionOrLiteral, defaultValue: Expression): Expression | undefined {
    return this.implementation.deserializeFromString(mediaType, content, defaultValue);
  }
  /** emits an expression to deserialize content from a content/response */
  deserializeFromResponse(mediaType: KnownMediaType, content: ExpressionOrLiteral, defaultValue: Expression): Expression | undefined {
    return this.implementation.deserializeFromResponse(mediaType, content, defaultValue);
  }
  serializeToContainerMember(mediaType: KnownMediaType, value: ExpressionOrLiteral, container: Variable, serializedName: string): OneOrMoreStatements {
    return this.implementation.serializeToContainerMember(mediaType, value, container, serializedName);
  }

  get isXmlAttribute(): boolean {
    return this.implementation.isXmlAttribute;
  }

  get isRequired(): boolean {
    return this.implementation.isRequired;
  }

  public isPolymorphic: boolean;
  /* @internal */ public validateMethod?: Method;
  /* @internal */ public discriminators: Map<string, ModelClass>;
  /* @internal */ public parentModelClasses: Array<ModelClass>;
  /* @internal */ public modelInterface!: ModelInterface;
  public get schema() { return this.implementation.schema; }
  /* @internal */ public state: State;
  /* @internal */ public btj!: Method;
  /* @internal */ public atj!: Method;
  /* @internal */ public bfj!: Method;
  /* @internal */ public afj!: Method;
  /* @internal */ public backingFields = new Array<BackingField>();
  /* @internal */ public implementation: ObjectImplementation;
  /* @internal */ public validationEventListenerParameter: Parameter;
  private validationStatements = new Statements();
  private jsonSerializer: JsonSerializableClass | undefined;
  private xmlSerializer: XmlSerializableClass | undefined;

  public hasHeaderProperties: boolean;

  constructor(namespace: Namespace, schemaWithFeatures: ObjectImplementation, state: State, objectInitializer?: Partial<ModelClass>) {

    super(namespace, schemaWithFeatures.schema.details.csharp.name);
    this.implementation = schemaWithFeatures;
    this.isPolymorphic = false;
    this.discriminators = new Map<string, ModelClass>();
    this.parentModelClasses = new Array<ModelClass>();
    this.state = state;

    this.apply(objectInitializer);
    this.partial = true;

    // create an interface for this model class

    // mark the code-model with the class we're creating.
    this.schema.details.csharp.classImplementation = this;

    // get all the header properties for this model
    this.hasHeaderProperties = values(this.schema.properties).linq.any(property => property.details.csharp[HeaderProperty] === HeaderPropertyType.Header || property.details.csharp[HeaderProperty] === HeaderPropertyType.Header);

    const modelInterface = this.schema.details.csharp.interfaceImplementation || new ModelInterface(this.namespace, this.schema, this, this.state);
    this.modelInterface = modelInterface;
    this.interfaces.push(modelInterface);

    if (this.schema.discriminator) {
      // this has a discriminator property.
      // our children are expected to tell us who they are
      this.isPolymorphic = true;
      // we'll add a deserializer factory method a bit later..
    }

    if (this.schema.extensions['x-ms-discriminator-value']) {
      // we have a discriminator value, and we should tell our parent who we are so that they can build a proper deserializer method.
      // um. just how do we *really* know which allOf is polymorphic?
      // that's really sad.
      for (const { key: eachAllOfIndex, value: parentSchema } of items(this.schema.allOf)) {
        const aState = this.state.path('allOf', eachAllOfIndex);

        // ensure the parent is already built.
        const parentDecl = this.state.project.modelsNamespace.resolveTypeDeclaration(parentSchema, true, aState);
        const parentClass = <ModelClass>parentSchema.details.csharp.classImplementation;

        if (parentClass.isPolymorphic) {
          // remember this class for later.
          this.parentModelClasses.push(parentClass);

          // tell that parent who we are.
          parentClass.addDiscriminator(this.schema.extensions['x-ms-discriminator-value'], this);
        }
      }
    }

    const defaultConstructor = this.addMethod(new Constructor(this, { description: `Creates an new <see cref="${this.name}" /> instance.` })); // default constructor for fits and giggles.

    this.validationEventListenerParameter = new Parameter('eventListener', ClientRuntime.IEventListener, { description: `an <see cref="${ClientRuntime.IEventListener}" /> instance that will receive validation events.` });

    // handle <allOf>s
    for (const { key: eachSchemaIndex, value: parentSchema } of items(this.schema.allOf)) {
      this.implementInterfaceForParentSchema(parentSchema, this.state.path('allOf', eachSchemaIndex))
    }

    // generate a protected backing field for each
    // and then expand the nested properties into this class forwarding to the member.

    // add properties
    for (const { key: index, value: property } of items(this.schema.properties)) {
      // each property that is in this schema will get a internal field in this class.
      const field = new ModelField(this, property, property.serializedName || index, this.state.path('properties', index));
      this.add(field);

      // old - remove this when you are done implementing virtual properties.
      // const prop = new ModelProperty(this, property, property.serializedName || propertyName, this.state.path('properties', propertyName));
      // this.add(prop);

      this.validationStatements.add(field.validatePresenceStatement(this.validationEventListenerParameter));
      this.validationStatements.add(field.validationStatement(this.validationEventListenerParameter));
    }

    // Add in virtual properties for this.
    // this includes:
    // -- properties for the internal fields in this class.
    // -- properties for the parent model properties that we're pulling thru (implementing via interface)
    // -- properties for nested properties that we're inlining.
    for (const eachVirtualProperty of values(this.schema.details.csharp.virtualProperties)) {
      // eachVirtualProperty.
      switch (eachVirtualProperty.kind) {
        case 'my-property':
          // one of my own properties.
          // this.add( new Property(eachVirtualProperty.propertyName)
          break;

        case 'parent-property':
          break;

        case 'inlined-property':
          break;
      }
    }

    if (this.schema.additionalProperties) {
      if (this.schema.additionalProperties === true) {
        // we're going to implement IDictionary<string, object>
        implementIDictionary(System.String, System.Object, this);

      } else {
        // we're going to implement IDictionary<string, schema.additionalProperties>

      }

    }
    if (!this.state.project.storagePipeline) {
      if (this.validationStatements.implementation.trim()) {
        // we do have something to valdiate!

        // add the IValidates implementation to this object.
        this.interfaces.push(ClientRuntime.IValidates);
        this.validateMethod = this.addMethod(new Method('Validate', System.Threading.Tasks.Task(), {
          async: Modifier.Async,
          parameters: [this.validationEventListenerParameter],
          description: `Validates that this object meets the validation criteria.`,
          returnsDescription: `A <see cref="${System.Threading.Tasks.Task()}" /> that will be complete when validation is completed.`
        }));
        this.validateMethod.add(this.validationStatements);
      }
    }

    // add from headers method if class or any of the parents pulls in header values.
    // FromHeaders( headers IEnumerable<KeyValuePair<string, IEnumerable<string>>> ) { ... }

    const headerProperties = values(this.properties).linq.where(p => (<ModelProperty>p).IsHeaderProperty);

    if (this.hasHeaderProperties) {
      // add header deserializer method
      const headers = new Parameter('headers', System.Net.Http.Headers.HttpResponseHeaders);

      const readHeaders = new Method('ReadHeaders', this, {
        access: Access.Internal,
        parameters: [headers],
        *body() {
          for (const hp of headerProperties) {
            const hparam = <ModelProperty>hp;
            if (hparam.serializedName === 'x-ms-meta') {
              yield `${hparam.backingName} = System.Linq.Enumerable.ToDictionary(System.Linq.Enumerable.Where(${valueOf(headers)}, header => header.Key.StartsWith("x-ms-meta-")), header => header.Key.Substring(10), header => System.Linq.Enumerable.FirstOrDefault(header.Value));`;
            } else {
              const values = `__${camelCase(['header', ...deconstruct(hparam.serializedName)])}Values`;
              yield If(`${valueOf(headers)}.TryGetValues("${hparam.serializedName}", out var ${values})`, `${hparam.assignPrivate(hparam.deserializeFromContainerMember(KnownMediaType.Header, headers, values))}`);
            }
          }
          yield `return this;`;
        }
      }).addTo(this);
    }
    const hasNonHeaderProperties = values(this.properties).linq.any(p => !(<ModelProperty>p).IsHeaderProperty);

    if (this.state.project.jsonSerialization) {
      this.jsonSerializer = new JsonSerializableClass(this);
    }

    if (hasNonHeaderProperties) {
      if (this.state.project.xmlSerialization) {
        this.xmlSerializer = new XmlSerializableClass(this);
      }
      // if (this.state.project.jsonSerialization) {
      // this.jsonSerializer = new JsonSerializableClass(this);
      // }
    }
  }

  getPrivateNameForField(baseName: string) {
    let n = 0;
    let name = baseName;
    do {
      if (!this.fields.find((v, i, a) => v.name === name)) {
        return name;
      }
      name = `${baseName}${n++}`;
    }
    while (n < 100);
    throw new Error(`Unexpected number of private fields with name ${baseName}`);
  }

  // add an 'implements' for the interface for the allOf.
  implementInterfaceForParentSchema(parentSchema: Schema, state: State, containerExpression: ExpressionOrLiteral = `this`) {
    // ensure the parent is already built.
    const parentTypeDeclaration = this.state.project.modelsNamespace.resolveTypeDeclaration(parentSchema, true, state);

    // add the interface as a parent to our interface.
    const parentInterface = <ModelInterface>parentSchema.details.csharp.interfaceImplementation;
    if (this.modelInterface.interfaces.indexOf(parentInterface)) {
      // already done this one (must be referred to more than once?)
      return;
    }
    this.modelInterface.interfaces.push(parentInterface);


    // add a field for the inherited values
    const className = (<ModelClass>parentSchema.details.csharp.classImplementation).fullName;
    const fieldName = this.getPrivateNameForField(`_${camelCase(deconstruct(className.replace(/^.*\./, '')))}`);

    const backingField = this.addField(new InitializedField(fieldName, parentTypeDeclaration, `new ${className}()`, { access: Access.Private, description: `Backing field for <see cref="${this.fileName}" />` }));
    this.backingFields.push({
      className,
      typeDeclaration: parentTypeDeclaration,
      field: backingField
    });

    // this.addVirtualPropertiesForParent(parentInterface, parentSchema, `${containerExpression}.${backingField}`);
    for (const each of parentInterface.allProperties) {
      const vp = new VirtualProperty(each.name, each, each, state, { description: `Inherited model <see cref="${parentInterface.name}" /> - ${parentSchema.details.csharp.description}` });
      this.add(vp);

      // make sure we don't over expose read-only properties.
      if (each.setAccess === Access.Internal) {
        // remove the setter for things that are internal
        vp.setterStatements = undefined;
      }

    }

    this.validationStatements.add(parentTypeDeclaration.validatePresence(this.validationEventListenerParameter, backingField));
    this.validationStatements.add(parentTypeDeclaration.validateValue(this.validationEventListenerParameter, backingField));

    // handle parents of parents
    let n = 0;
    for (const each of parentSchema.allOf) {
      this.implementInterfaceForParentSchema(parentSchema, state.path('allOf', n++), `${containerExpression}.${backingField}`);
    }
  }

  addVirtualPropertiesForParent(parentInterface: ModelInterface, parentSchema: Schema, containerExpression: ExpressionOrLiteral = `this`) {
    // now, create proxy properties for the members
    for (const each of parentInterface.allProperties) {

    }
  }

  public validateValue(eventListener: Variable, property: Variable): OneOrMoreStatements {
    return this.implementation.validateValue(eventListener, property);
  }
  public validatePresence(eventListener: Variable, property: Variable): OneOrMoreStatements {
    return this.implementation.validatePresence(eventListener, property);
  }

  public addDiscriminator(discriminatorValue: string, modelClass: ModelClass) {
    this.discriminators.set(discriminatorValue, modelClass);

    // tell any polymorphic parents incase we're doing subclass of a subclass.
    for (const each of this.parentModelClasses) {
      each.addDiscriminator(discriminatorValue, modelClass);
    }
  }
}
