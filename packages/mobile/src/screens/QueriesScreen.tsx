import React from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import { ValidationQuery } from '../types/mobile-app';
import { styles } from '../theme/styles';

interface QueriesScreenProps {
  queries: ValidationQuery[];
  activeQuery: ValidationQuery | null;
  queryResponseText: string;
  onSelectQuery: (q: ValidationQuery) => void;
  onChangeResponseText: (text: string) => void;
  onRespond: () => void;
}

export const QueriesScreen: React.FC<QueriesScreenProps> = ({
  queries,
  activeQuery,
  queryResponseText,
  onSelectQuery,
  onChangeResponseText,
  onRespond,
}) => {
  return (
    <View>
      <Text style={styles.sectionHeading}>Validator Clarification Queries</Text>
      {queries.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyText}>🎉 No open queries for this branch.</Text>
        </View>
      ) : (
        queries.map((q) => (
          <View key={q.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.queryValidator}>Validator: {q.validatorName}</Text>
              <Text style={styles.queryStatus}>{q.status}</Text>
            </View>
            <Text style={styles.queryCust}>Customer: {q.customerName} ({q.accountNumber})</Text>
            <Text style={styles.queryBody}>"{q.queryText}"</Text>

            {q.assayerResponse ? (
              <View style={styles.responseBox}>
                <Text style={styles.responseTextTitle}>Your Response:</Text>
                <Text style={styles.responseText}>{q.assayerResponse}</Text>
              </View>
            ) : (
              <View>
                {activeQuery?.id === q.id ? (
                  <View style={{ marginTop: 10 }}>
                    <TextInput
                      style={styles.textInput}
                      placeholder="Type clarification response..."
                      placeholderTextColor="#94a3b8"
                      value={queryResponseText}
                      onChangeText={onChangeResponseText}
                    />
                    <TouchableOpacity style={styles.respondBtn} onPress={onRespond}>
                      <Text style={styles.btnTextWhite}>Send Clarification Response</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity style={styles.respondBtn} onPress={() => onSelectQuery(q)}>
                    <Text style={styles.btnTextWhite}>💬 Respond to Query</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>
        ))
      )}
    </View>
  );
};
