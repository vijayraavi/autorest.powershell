/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Field, ExpressionOrLiteral, TypeDeclaration, valueOf } from '@microsoft.azure/codegen-csharp';
import { ImplementedProperty, Property } from '@microsoft.azure/codegen-csharp';
import { Statements } from '@microsoft.azure/codegen-csharp';
import { State } from '../generator';

export class ProxyProperty extends ImplementedProperty {
  constructor(protected backingFieldObject: Field, protected backingFieldProperty: Property, state: State, objectInitializer?: Partial<ProxyProperty>) {
    super(backingFieldProperty.name, backingFieldProperty.type);
    this.apply(objectInitializer);
    this.getterStatements = new Statements(`return ${this.backingFieldObject.name}.${this.backingFieldProperty.name};`);
    this.setterStatements = new Statements(`${this.backingFieldObject.name}.${this.backingFieldProperty.name} = value;`);
  }
}

export class VirtualProperty extends ImplementedProperty {
  constructor(name: string, containerExpression: ExpressionOrLiteral, type: TypeDeclaration, state: State, objectInitializer?: Partial<VirtualProperty>) {
    super(name, type);
    this.apply(objectInitializer);
    this.getterStatements = new Statements(`return ${valueOf(containerExpression)}.${name};`);
    this.setterStatements = new Statements(`${valueOf(containerExpression)}.${name} = value;`);
  }
}