import { Definition } from '@resin/odata-to-abstract-sql';

import * as _ from 'lodash';
import { readFileSync } from 'fs';
import { sbvrUtils } from '@resin/pinejs';
import { AbstractSqlModel } from '@resin/abstract-sql-compiler';

export const generateAbstractSqlModel = (
	seModelPath: string,
): AbstractSqlModel => {
	const seModel = readFileSync(seModelPath, 'utf8');
	const lfModel = sbvrUtils.generateLfModel(seModel);
	return sbvrUtils.generateAbstractSqlModel(lfModel);
};

export const aliasTable = (
	abstractSqlModel: AbstractSqlModel,
	resourceName: string,
	toResourceName: string,
	definition?: Definition,
) => {
	abstractSqlModel.tables[toResourceName] = _.cloneDeep(
		abstractSqlModel.tables[resourceName],
	);
	if (definition) {
		abstractSqlModel.tables[toResourceName].definition = definition;
	}

	abstractSqlModel.relationships[toResourceName] = _.cloneDeep(
		abstractSqlModel.relationships[resourceName],
	);
};

export const renameField = (
	abstractSqlModel: AbstractSqlModel,
	resourceName: string,
	path: string[],
	from: string,
	to: string,
) => {
	abstractSqlModel.tables[resourceName].fields.forEach(field => {
		if (field.fieldName === from) {
			field.fieldName = to;
		}
	});
	abstractSqlModel.tables[resourceName].indexes.forEach(index => {
		index.fields = index.fields.map(field => {
			if (field === from) {
				return to;
			}
			return field;
		});
	});

	const relationship = abstractSqlModel.relationships[resourceName];

	const orig = _.get(relationship, path);
	orig[to] = orig[from];
	delete orig[from];

	_.set(relationship, to, _.get(relationship, from));
	delete relationship[from];
	_.set(relationship, [to, '$'], [to]);
};

export const renameEnvVarName = (abstractSql: AbstractSqlModel) => {
	// Patching device environment variable term
	renameField(
		abstractSql,
		'device-has-env var name',
		['device', 'has'],
		'env var name',
		'name',
	);
	renameField(
		abstractSql,
		'device-has-env var name',
		['has'],
		'env var name',
		'name',
	);
	// Patching application environment variable term
	renameField(
		abstractSql,
		'application-has-env var name',
		['application', 'has'],
		'env var name',
		'name',
	);
	renameField(
		abstractSql,
		'application-has-env var name',
		['has'],
		'env var name',
		'name',
	);
};
